import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = path.join(root, 'src-tauri', 'resources');
const app = path.join(resources, 'app');
const runtime = path.join(resources, 'runtime');
const nodeVersion = process.versions.node.split('.').map(Number);

if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 12)) {
  throw new Error('Desktop builds require Node.js 22.12 or newer to bundle the server runtime.');
}

await rm(resources, { recursive: true, force: true });
await mkdir(path.join(app, 'dist'), { recursive: true });
await mkdir(runtime, { recursive: true });

await cp(path.join(root, 'dist', 'cli.js'), path.join(app, 'dist', 'cli.js'));
for (const directory of ['core', 'git', 'server']) {
  await cp(path.join(root, 'dist', directory), path.join(app, 'dist', directory), {
    recursive: true,
    filter: source => !path.extname(source) || path.extname(source) === '.js',
  });
}
await cp(path.join(root, 'dist', 'web'), path.join(app, 'dist', 'web'), { recursive: true });
await cp(path.join(root, 'package.json'), path.join(app, 'package.json'));
await cp(path.join(root, 'package-lock.json'), path.join(app, 'package-lock.json'));

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: app,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (install.error) throw install.error;
if (install.status !== 0) throw new Error('Could not install the production-only Node server dependencies.');

const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
const bundledNode = path.join(runtime, runtimeName);
await cp(process.execPath, bundledNode);
if ((await stat(bundledNode)).size === 0) throw new Error('The bundled Node runtime is empty.');
