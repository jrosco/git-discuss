import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, errorMessage } from './api.js';
import { ErrorNotice } from './components.js';
import { ReviewsWorkspace } from './reviews.js';
import { CommitNotesWorkspace } from './commit-notes.js';
import { SharingPanel } from './sharing.js';
import './styles.css';

function App() {
  const [workspace, setWorkspace] = useState<'reviews' | 'notes'>('reviews');
  const [repository, setRepository] = useState<{ root: string; initialCommit: string } | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);
  const [localChanges, setLocalChanges] = useState(false);
  async function connect() {
    setError('');
    try { setRepository(await api<{ root: string; initialCommit: string }>('repository')); }
    catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => { void connect(); }, []);
  function showSharing() {
    const panel = document.getElementById('sharing-area');
    panel?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    const button = document.getElementById('share-button') as HTMLButtonElement | null;
    if (button && !button.disabled) button.focus({ preventScroll: true });
    else panel?.focus({ preventScroll: true });
  }
  const projectName = repository?.root.replace(/[\\/]$/, '').split(/[\\/]/).pop();
  return <main>
    <a className="skip-link" href="#workspace-content">Skip to discussions</a>
    <header className="page-header">
      <div><div className="eyebrow">BETTER CODE THROUGH CONVERSATION</div><h1>Git Discuss<span className="dot">.</span></h1></div>
      <span className="badge">{syncing ? 'Exchanging feedback' : localChanges ? 'New changes saved here' : 'Saved here first'}</span>
    </header>
    <div className="project-context"><strong>{projectName || (error ? 'Project unavailable' : 'Opening your project…')}</strong>
      {repository && <details><summary>Project location</summary><code>{repository.root}</code></details>}
    </div>
    <ErrorNotice message={error} onRetry={() => void connect()} />
    {repository && <div id="sharing-area" tabIndex={-1}><SharingPanel busy={syncing} localChanges={localChanges} onBusy={setSyncing} onFinished={success => {
      setSyncVersion(version => version + 1); if (success) setLocalChanges(false);
    }} /></div>}
    <div className="workspace-layout">
      <nav className="workspace-nav" aria-label="Discussion workspaces">
        <div className="eyebrow">WHAT WOULD YOU LIKE TO DO?</div>
        <button type="button" aria-current={workspace === 'reviews' ? 'page' : undefined} aria-controls="reviews-workspace" onClick={() => setWorkspace('reviews')}>
          <strong>Reviews</strong><span>Get feedback as your work evolves</span>
        </button>
        <button type="button" aria-current={workspace === 'notes' ? 'page' : undefined} aria-controls="notes-workspace" onClick={() => setWorkspace('notes')}>
          <strong>Change notes</strong><span>Leave a note on one saved change</span>
        </button>
        <details className="workspace-guide"><summary>Which should I use?</summary>
          <p><strong>Reviews</strong> keep feedback together as you update your code. Start here for most team reviews.</p>
          <p><strong>Change notes</strong> attach a discussion to one saved snapshot, called a commit in Git.</p>
          <p>These are separate discussions. Switching between them keeps your drafts in this open page.</p>
        </details>
      </nav>
      <fieldset id="workspace-content" tabIndex={-1} className="workspace-content workspace-controls" disabled={syncing}>
        <legend className="sr-only">Discussion workspace</legend>
        {/* Keep both mounted: navigation and sharing must not discard drafts or selected versions. */}
        <section id="reviews-workspace" aria-labelledby="reviews-heading" hidden={workspace !== 'reviews'}>
          <header className="workspace-heading"><div className="eyebrow">DISCUSS WORK IN PROGRESS</div><h2 id="reviews-heading">Reviews</h2>
            <p>Choose changes, ask for feedback, and keep the conversation together as you update your code.</p></header>
          {repository && <ReviewsWorkspace syncVersion={syncVersion} onSaved={() => setLocalChanges(true)} onShare={showSharing} />}
        </section>
        <section id="notes-workspace" aria-labelledby="notes-heading" hidden={workspace !== 'notes'}>
          <header className="workspace-heading"><div className="eyebrow">CAPTURE CONTEXT FOR ONE CHANGE</div><h2 id="notes-heading">Change notes</h2>
            <p>Leave a question or explanation on a specific saved change. The note stays with that snapshot of the code.</p></header>
          {repository && <CommitNotesWorkspace initialCommit={repository.initialCommit} syncVersion={syncVersion} onSaved={() => setLocalChanges(true)} onShare={showSharing} />}
        </section>
      </fieldset>
    </div>
    <footer>Feedback saves on this computer first. Choose <strong>Share & get updates</strong> when you’re ready to exchange it with your team.</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
