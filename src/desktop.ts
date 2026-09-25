import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Repository } from './git/repository.js';
import { Reviews } from './core/reviews.js';
import { createServer } from './server/app.js';

type ServerSession = { root: string; url: string; close: () => Promise<void> };

const MAX_RECENT_REPOSITORIES = 8;
const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  let tray: Tray | undefined;
  const sessions = new Map<string, ServerSession>();
  const startingSessions = new Map<string, Promise<ServerSession>>();
  let activeRepository: string | undefined;
  let recentRepositories: string[] = [];
  let ready = false;
  let pendingSecondInstance = false;
  let isQuitting = false;
  let shutdownComplete = false;
  let shutdownPromise: Promise<void> | undefined;
  let settingsWrite: Promise<void> = Promise.resolve();

  const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

  async function saveSettings() {
    settingsWrite = settingsWrite.catch(() => undefined).then(async () => {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(settingsPath(), JSON.stringify({ recentRepositories }, null, 2), 'utf8');
    });
    try {
      await settingsWrite;
    } catch (error) {
      console.error(`Could not save desktop settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function loadSettings() {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && 'recentRepositories' in parsed && Array.isArray(parsed.recentRepositories)) {
        recentRepositories = [...new Set(parsed.recentRepositories.filter((item): item is string => typeof item === 'string').map(item => path.resolve(item)))].slice(0, MAX_RECENT_REPOSITORIES);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Could not read desktop settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function updateTrayMenu() {
    if (!tray) return;
    const active = activeRepository ? sessions.get(activeRepository) : undefined;
    const runningItems = [...sessions.values()].map(session => ({
      label: `${session.root === activeRepository ? '● ' : ''}${session.root}`,
      type: 'normal' as const,
      click: () => { void activateRepository(session.root, true); },
    }));
    const recentItems = recentRepositories.map(root => ({
      label: root,
      type: 'normal' as const,
      click: () => { void activateRepository(root, true); },
    }));
    const closeItems = [...sessions.values()].map(session => ({
      label: session.root,
      type: 'normal' as const,
      click: () => { void closeRepository(session.root); },
    }));
    tray.setToolTip(active ? `Git Discuss — ${active.root}` : `Git Discuss — ${sessions.size} repositories running`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: active ? `Active repository: ${active.root}` : `${sessions.size} repositories running`, enabled: false },
      { label: 'Open Git Discuss', click: () => { void openInterface(); } },
      { label: 'Open repository…', click: () => { void chooseRepository(); } },
      { label: 'Running repositories', submenu: runningItems.length ? runningItems : [{ label: 'No running repositories', enabled: false }] },
      { label: 'Recent repositories', submenu: recentItems.length ? recentItems : [{ label: 'No recent repositories', enabled: false }] },
      { label: 'Close repository', submenu: closeItems.length ? closeItems : [{ label: 'No running repositories', enabled: false }] },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit(); } },
    ]));
  }

  function startSession(repository: Repository): Promise<ServerSession> {
    return (async () => {
      const reviews = new Reviews(repository);
      await reviews.conversation('HEAD');
      const { app: server, token } = await createServer(reviews);
      try {
        const address = await server.listen({ host: '127.0.0.1', port: 0 });
        return { root: repository.root, url: `${address}/#token=${token}`, close: () => server.close() };
      } catch (error) {
        await server.close();
        throw error;
      }
    })();
  }

  async function ensureSession(repository: Repository) {
    const existing = sessions.get(repository.root);
    if (existing) return existing;

    let pending = startingSessions.get(repository.root);
    if (!pending) {
      pending = startSession(repository);
      startingSessions.set(repository.root, pending);
    }
    try {
      const session = await pending;
      sessions.set(repository.root, session);
      return session;
    } finally {
      if (startingSessions.get(repository.root) === pending) startingSessions.delete(repository.root);
    }
  }

  async function activateRepository(root: string, openAfterStart = false) {
    try {
      if (isQuitting) return;
      const repository = await Repository.open(root);
      if (isQuitting) return;
      const session = await ensureSession(repository);
      if (isQuitting) return;
      activeRepository = repository.root;
      recentRepositories = [repository.root, ...recentRepositories.filter(item => item !== repository.root)].slice(0, MAX_RECENT_REPOSITORIES);
      updateTrayMenu();
      await saveSettings();
      if (openAfterStart) await openSession(session);
    } catch (error) {
      if (!isQuitting) dialog.showErrorBox('Could not open repository', error instanceof Error ? error.message : String(error));
    }
  }

  async function closeRepository(root: string) {
    const session = sessions.get(root);
    if (!session) return;
    sessions.delete(root);
    if (activeRepository === root) activeRepository = sessions.keys().next().value;
    updateTrayMenu();
    try {
      await session.close();
    } catch (error) {
      sessions.set(root, session);
      activeRepository ??= root;
      updateTrayMenu();
      dialog.showErrorBox('Could not close repository', error instanceof Error ? error.message : String(error));
    }
  }

  async function chooseRepository() {
    const result = await dialog.showOpenDialog({
      title: 'Choose a Git repository',
      properties: ['openDirectory', 'showHiddenFiles'],
      ...(activeRepository ? { defaultPath: activeRepository } : recentRepositories[0] ? { defaultPath: recentRepositories[0] } : {}),
    });
    if (!result.canceled && result.filePaths[0]) await activateRepository(result.filePaths[0], true);
  }

  async function openSession(session: ServerSession) {
    activeRepository = session.root;
    updateTrayMenu();
    try {
      await shell.openExternal(session.url);
    } catch (error) {
      dialog.showErrorBox('Could not open Git Discuss', error instanceof Error ? error.message : String(error));
    }
  }

  async function openInterface() {
    const active = activeRepository ? sessions.get(activeRepository) : undefined;
    if (!active) {
      await chooseRepository();
      return;
    }
    await openSession(active);
  }

  async function createTrayIcon() {
    const svg = await readFile(path.join(app.getAppPath(), 'assets', 'icon.svg'));
    const png = await sharp(svg).resize(32, 32, { fit: 'contain' }).png().toBuffer();
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error('The app icon could not be rendered.');
    return image;
  }

  app.on('second-instance', () => {
    if (ready) void openInterface();
    else pendingSecondInstance = true;
  });

  app.on('before-quit', event => {
    isQuitting = true;
    if (shutdownComplete) return;
    if (sessions.size === 0 && startingSessions.size === 0 && !shutdownPromise) return;
    event.preventDefault();
    if (shutdownPromise) return;
    const toClose = new Map(sessions);
    const pending = [...startingSessions.values()];
    sessions.clear();
    activeRepository = undefined;
    shutdownPromise = (async () => {
      const started = await Promise.allSettled(pending);
      for (const result of started) {
        if (result.status === 'fulfilled') toClose.set(result.value.root, result.value);
        else console.error(`Could not start a repository server during shutdown: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
      const closed = await Promise.allSettled([...toClose.values()].map(session => session.close()));
      for (const result of closed) {
        if (result.status === 'rejected') console.error(`Could not stop a local server cleanly: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    })().catch(error => {
      console.error(`Could not stop the local server cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });

  app.whenReady().then(async () => {
    await loadSettings();
    tray = new Tray(await createTrayIcon());
    tray.on('click', () => { void openInterface(); });
    updateTrayMenu();
    ready = true;
    const lastRepository = recentRepositories[0];
    if (lastRepository) await activateRepository(lastRepository);
    if (pendingSecondInstance) void openInterface();
  }).catch(error => {
    dialog.showErrorBox('Git Discuss could not start', error instanceof Error ? error.message : String(error));
    app.quit();
  });

}
