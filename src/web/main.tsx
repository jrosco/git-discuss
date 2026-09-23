import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, errorMessage } from './api.js';
import { ErrorNotice } from './components.js';
import { ReviewsWorkspace } from './reviews.js';
import { CommitNotesWorkspace } from './commit-notes.js';
import { SharingPanel } from './sharing.js';
import './styles.css';
import type { BackgroundUpdateStatus, SyncResult } from '../core/models.js';
import type { ComposerSharing } from './submission.js';

type Theme = 'light' | 'dark';
type Workspace = 'reviews' | 'notes';
const workspaceStorageKey = 'git-discuss-workspace';
function initialWorkspace(): Workspace {
  try {
    const saved = sessionStorage.getItem(workspaceStorageKey);
    if (saved === 'reviews' || saved === 'notes') return saved;
  } catch { /* Navigation still works if browser storage is unavailable. */ }
  return 'reviews';
}
type RepositoryInfo = { root: string; initialCommit: string; currentBranch: string | null };
const themeStorageKey = 'git-discuss-theme';
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(themeStorageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Theme switching still works when browser storage is unavailable. */ }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
const startingTheme = initialTheme();
document.documentElement.dataset.theme = startingTheme;

function App() {
  const [theme, setTheme] = useState<Theme>(startingTheme);
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  useEffect(() => {
    try { sessionStorage.setItem(workspaceStorageKey, workspace); } catch { /* Keep navigation usable without storage. */ }
  }, [workspace]);
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);
  const [backgroundRevision, setBackgroundRevision] = useState(0);
  const [backgroundSummary, setBackgroundSummary] = useState<BackgroundUpdateStatus['latestChangeSummary']>(null);
  const [localChanges, setLocalChanges] = useState(false);
  const [sharingRemote, setSharingRemote] = useState('');
  const [shareSuccessVersion, setShareSuccessVersion] = useState(0);
  const [immediateShareResult, setImmediateShareResult] = useState<SyncResult | null>(null);
  const [reviewDetailsTarget, setReviewDetailsTarget] = useState<HTMLDivElement | null>(null);
  const composerSharing: ComposerSharing = {
    remote: sharingRemote, successVersion: shareSuccessVersion,
    onSharing: active => { setSyncing(active); if (active) setImmediateShareResult(null); },
    onShared: result => {
      setSyncVersion(version => version + 1);
      if (result) { setLocalChanges(false); setShareSuccessVersion(version => version + 1); setImmediateShareResult(result); }
    },
  };
  async function connect() {
    setError('');
    try { setRepository(await api<RepositoryInfo>('repository')); }
    catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => {
    void connect();
    const refresh = () => { void connect(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [syncVersion]);
  function showSharing() {
    const panel = document.getElementById('sharing-area');
    panel?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    const button = document.getElementById('share-button') as HTMLButtonElement | null;
    if (button && !button.disabled) button.focus({ preventScroll: true });
    else panel?.focus({ preventScroll: true });
  }
  const projectName = repository?.root.replace(/[\\/]$/, '').split(/[\\/]/).pop();
  return <main>
    <a className="skip-link" href="#workspace-content">Skip to reviews and notes</a>
    <header className="page-header">
      <div className="app-brand"><svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 7v10M17 17V9a5 5 0 0 0-5-5h-1" /><circle cx="6" cy="4" r="2.5" /><circle cx="6" cy="20" r="2.5" /><circle cx="17" cy="20" r="2.5" /><path d="m14 1-3 3 3 3" /></svg><h1>Git Discuss</h1></div>
      <div className="header-actions">
        <span className="badge">{syncing ? 'Exchanging feedback' : localChanges ? 'New changes saved here' : 'Saved here first'}</span>
        <button type="button" className="secondary-button theme-toggle" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => {
            const next = theme === 'dark' ? 'light' : 'dark';
            setTheme(next); document.documentElement.dataset.theme = next;
            try { localStorage.setItem(themeStorageKey, next); } catch { /* Keep the choice for this open page. */ }
          }}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
            {theme === 'light' ? <path d="M20 14a8.5 8.5 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
          </svg>{theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
    <div className="project-context"><strong>{projectName || (error ? 'Project unavailable' : 'Opening your project…')}</strong>
      {repository && <span className="branch-badge" aria-label={repository.currentBranch ? `Current branch: ${repository.currentBranch}` : 'No branch checked out: detached HEAD'}
        title={repository.currentBranch ? `Currently checked-out branch: ${repository.currentBranch}` : 'You are viewing a specific commit rather than a branch.'}>
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4" cy="3" r="2" /><circle cx="4" cy="13" r="2" /><circle cx="12" cy="3" r="2" /><path d="M4 5v6m8-6v1a4 4 0 0 1-4 4H4" /></svg>
        {repository.currentBranch || 'Detached HEAD'}
      </span>}
      {repository && <details><summary>Project location</summary><code>{repository.root}</code></details>}
    </div>
    <ErrorNotice message={error} onRetry={() => void connect()} />
    <div className="workspace-layout">
      <nav className="workspace-nav" aria-label="Discussion workspaces">
        <div className="sr-only">Discussion workspaces</div>
        <button type="button" aria-current={workspace === 'reviews' ? 'page' : undefined} aria-controls="reviews-workspace" onClick={() => setWorkspace('reviews')}>
          <strong>Reviews</strong><span>Get feedback as your work evolves</span>
        </button>
        <button type="button" aria-current={workspace === 'notes' ? 'page' : undefined} aria-controls="notes-workspace" onClick={() => setWorkspace('notes')}>
          <strong>Change notes</strong><span>Leave a note on one saved change</span>
        </button>
        <details className="workspace-guide"><summary>Which should I use?</summary>
          <p><strong>Reviews</strong> keep feedback together as you update your code. Start here for most team reviews.</p>
          <p><strong>Change notes</strong> attach notes to one saved snapshot, called a commit in Git.</p>
          <p>These are separate workspaces. Switching between them keeps your drafts in this open page.</p>
        </details>
      </nav>
      <fieldset id="workspace-content" tabIndex={-1} className="workspace-content workspace-controls" disabled={syncing}>
        <legend className="sr-only">Discussion workspace</legend>
        {/* Keep both mounted: navigation and sharing must not discard drafts or selected versions. */}
        <section id="reviews-workspace" aria-labelledby="reviews-heading" hidden={workspace !== 'reviews'}>
          <header className="workspace-heading"><div className="eyebrow">DISCUSS WORK IN PROGRESS</div><h2 id="reviews-heading">Reviews</h2>
            <p>Review a branch and keep the conversation together as new commits are pushed.</p></header>
          {repository && <ReviewsWorkspace syncVersion={syncVersion} backgroundRevision={backgroundRevision} backgroundSummary={backgroundSummary} sharing={composerSharing} sidebarTarget={reviewDetailsTarget} onSaved={() => setLocalChanges(true)} onShare={showSharing} />}
        </section>
        <section id="notes-workspace" aria-labelledby="notes-heading" hidden={workspace !== 'notes'}>
          <header className="workspace-heading"><div className="eyebrow">CAPTURE CONTEXT FOR ONE CHANGE</div><h2 id="notes-heading">Change notes</h2>
            <p>Leave a question or explanation on a specific saved change. The note stays with that snapshot of the code.</p></header>
          {repository && <CommitNotesWorkspace initialCommit={repository.initialCommit} syncVersion={syncVersion} backgroundRevision={backgroundRevision} backgroundSummary={backgroundSummary} sharing={composerSharing} onSaved={() => setLocalChanges(true)} onShare={showSharing} />}
        </section>
      </fieldset>
      {repository && <aside className="sharing-sidebar" aria-label="Team sharing and review details">
        <div id="sharing-area" tabIndex={-1}><SharingPanel busy={syncing} localChanges={localChanges} onBusy={setSyncing} onBackgroundRevision={setBackgroundRevision}
          onBackgroundSummary={setBackgroundSummary} onRemoteChange={setSharingRemote} externalResult={immediateShareResult} onFinished={success => {
          setSyncVersion(version => version + 1); if (success) { setLocalChanges(false); setShareSuccessVersion(version => version + 1); }
        }} /></div>
        <fieldset disabled={syncing} hidden={workspace !== 'reviews'} className="review-sidebar-controls">
          <legend className="sr-only">Reviewed code and details</legend>
          <div ref={setReviewDetailsTarget} />
        </fieldset>
      </aside>}
    </div>
    <footer>Feedback saves on this computer first. Choose <strong>Share & get updates</strong> when you’re ready to exchange it with your team.</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
