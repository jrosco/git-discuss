import { useEffect, useRef, useState } from 'react';
import type { BackgroundUpdateStatus, BranchChoice, Comment, CommitPage, Conversation, NoteCounts, SyncResult } from '../core/models.js';
import { api, errorMessage } from './api.js';
import { BranchOptions, CommentSubmitActions, ErrorNotice, SavedButUnshared, SavedNotice, UpdatesNotice } from './components.js';
import { MarkdownEditor, MarkdownPreview } from './markdown.js';
import { submitFeedback, type ComposerSharing } from './submission.js';

function ChangePicker({ initialCommit, conversation, syncVersion, backgroundRevision, busy, onLoad }: {
  initialCommit: string; conversation: Conversation | null; syncVersion: number; backgroundRevision: number; busy: boolean; onLoad: (ref: string) => Promise<void>;
}) {
  const [branches, setBranches] = useState<BranchChoice[]>([]);
  const [branch, setBranch] = useState(initialCommit);
  const [customRef, setCustomRef] = useState('');
  const [history, setHistory] = useState<CommitPage | null>(null);
  const [notesOnly, setNotesOnly] = useState(false);
  const [browsing, setBrowsing] = useState(true);
  const [error, setError] = useState('');
  const [countError, setCountError] = useState('');
  const currentCommit = conversation?.commit;
  async function browse(nextBranch: string) {
    setBrowsing(true); setError(''); setCountError('');
    try {
      const [choices, page] = await Promise.all([
        api<BranchChoice[]>('branches'), api<CommitPage>(`commits?ref=${encodeURIComponent(nextBranch)}`),
      ]);
      setBranches(choices); setHistory(page); setBranch(nextBranch);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBrowsing(false); }
  }
  useEffect(() => { void browse(initialCommit); }, [initialCommit]);
  useEffect(() => {
    if (!history) return;
    let active = true;
    setCountError('');
    if (conversation) setHistory(current => current ? { ...current, commits: current.commits.map(item =>
      item.commit === conversation.commit ? { ...item, noteCount: conversation.note?.trim() ? 1 : 0 } : item) } : current);
    const commits = history.commits.map(item => item.commit);
    void (async () => {
      const counts: NoteCounts = {};
      for (let offset = 0; offset < commits.length; offset += 100) {
        Object.assign(counts, await api<NoteCounts>('note-counts', { commits: commits.slice(offset, offset + 100) }));
        if (!active) return;
      }
      if (active) setHistory(current => current ? { ...current, commits: current.commits.map(item =>
        Object.hasOwn(counts, item.commit) ? { ...item, noteCount: counts[item.commit] } : item) } : current);
    })().catch(error => { if (active) setCountError(errorMessage(error)); });
    return () => { active = false; };
  }, [syncVersion, backgroundRevision, history?.tip, conversation]);
  async function loadOlder() {
    if (!history || history.nextOffset === null) return;
    setBrowsing(true); setError('');
    try {
      const page = await api<CommitPage>(`commits?ref=${history.tip}&offset=${history.nextOffset}`);
      setHistory(current => current?.tip === page.tip ? { ...page, commits: [...current.commits, ...page.commits] } : current);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBrowsing(false); }
  }
  const disabled = busy || browsing;
  const visibleCommits = history?.commits.filter(item => !notesOnly || item.noteCount === 1) ?? [];
  return <section className="card change-picker" aria-label="Find a saved change">
    <h3>Choose a saved change</h3>
    <p className="form-intro">A saved change is called a <strong>commit</strong> in Git. Open one below to read or leave a note.</p>
    <label htmlFor="notes-branch">Where should we look?</label>
    <div className="row"><select id="notes-branch" value={branch} disabled={disabled} onChange={event => void browse(event.target.value)}>
      <BranchOptions branches={branches} />
      {branch !== 'HEAD' && !branches.some(item => item.ref === branch) && <option value={branch}>Starting code · {branch}</option>}
    </select><button type="button" className="secondary-button" disabled={disabled} onClick={() => void browse(branch)}>Refresh list</button></div>
    <p className="field-hint">Branches are named lines of work. Team branches show the code last downloaded to this computer.</p>
    <form onSubmit={event => { event.preventDefault(); void onLoad(customRef); }}>
      <label htmlFor="custom-commit">Commit ID or branch name</label>
      <div className="row"><input id="custom-commit" disabled={disabled} value={customRef} onChange={event => setCustomRef(event.target.value)} required maxLength={256} placeholder="Paste a commit ID or enter a branch name" />
        <button disabled={disabled || !customRef.trim()}>Open notes</button></div>
    </form>
    <label className="checkbox-label notes-only-toggle"><input type="checkbox" checked={notesOnly} onChange={event => setNotesOnly(event.target.checked)} disabled={disabled} />
      Show only commits with notes</label>
    <ErrorNotice message={error} onRetry={() => void browse(branch)} />
    {countError && <p className="field-hint" role="status">Note counts could not be refreshed. Choose Refresh list to try again.</p>}
    {browsing && <p role="status" className="muted">Finding saved changes…</p>}
    {history && <>
      <ul className="change-list" aria-label="Saved changes, newest first">{visibleCommits.map(item => <li key={item.commit}>
        <button type="button" className="change-card" disabled={disabled} aria-current={currentCommit === item.commit ? 'true' : undefined} onClick={() => void onLoad(item.commit)}>
          <span className="change-title"><span>{item.subject || 'Untitled change'}</span><span className="change-badges">
            {item.noteCount === 1 && <span className="note-count has-notes" title="Note saved on this commit">
              <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 3v-3H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" /></svg>
              <span className="sr-only">Note saved on this commit</span>
            </span>}
            {currentCommit === item.commit && <span className="version-badge">Open</span>}
          </span></span>
          <span className="review-card-meta">{item.author} · {new Date(item.authoredAt).toLocaleDateString()} <code>{item.commit.slice(0, 8)}</code></span>
        </button>
      </li>)}</ul>
      {!visibleCommits.length && <p className="empty">No saved changes match this filter.</p>}
      <div className="commit-history-footer"><small>{history.commits.length} saved changes{history.nextOffset === null ? ' · End of history' : ''}</small>
        {history.nextOffset !== null && <button type="button" className="text-button" disabled={disabled} onClick={() => void loadOlder()}>Show older changes</button>}</div>
    </>}
  </section>;
}

export function CommitNotesWorkspace({ initialCommit, syncVersion, backgroundRevision, backgroundSummary, sharing, onSaved, onShare }: {
  initialCommit: string;
  syncVersion: number;
  backgroundRevision: number;
  backgroundSummary: BackgroundUpdateStatus['latestChangeSummary'];
  sharing: ComposerSharing;
  onSaved: () => void;
  onShare: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const selectedCommit = useRef(initialCommit);
  const [noteBody, setNoteBody] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [seenRevision, setSeenRevision] = useState(0);
  const [deferredRefresh, setDeferredRefresh] = useState(false);
  const [sharingNow, setSharingNow] = useState(false);
  const [shareError, setShareError] = useState('');
  const [mode, setMode] = useState<'idle' | 'add' | 'edit' | 'append'>('idle');
  useEffect(() => { setShareError(''); }, [sharing.successVersion]);

  function actionForMode(current: 'idle' | 'add' | 'edit' | 'append') {
    if (current === 'idle') return 'set' as const;
    if (current === 'append') return 'append' as const;
    return current;
  }

  async function submitNote(shareNow: boolean) {
    if (!conversation || busy || (shareNow && !sharing.remote)) return;
    const remote = sharing.remote;
    setBusy(true); setError(''); setNotice(''); setShareError(''); setSharingNow(shareNow);
    if (shareNow) sharing.onSharing(true);
    try {
      const result = await submitFeedback(
        () => api<Comment>('comments', { commit: conversation.commit, body: noteBody, action: actionForMode(mode) }),
        async () => {
          const next = await api<Conversation>(`conversation?commit=${encodeURIComponent(conversation.commit)}`);
          setConversation(next); setNoteBody(next.note ?? '');
          setNotice('Note saved on this computer.');
          setMode('idle');
          onSaved();
        },
        shareNow ? () => api<SyncResult>('sync', { remote }) : undefined,
      );
      if (result.kind === 'shared') sharing.onShared(result.result);
      else if (result.kind === 'saved-unshared') { setShareError(result.error); sharing.onShared(null); }
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); setSharingNow(false); if (shareNow) sharing.onSharing(false); }
  }
  async function refresh(options: { announce?: boolean } = {}) {
    const scroll = { left: window.scrollX, top: window.scrollY };
    setBusy(true); setError('');
    try {
      const next = await api<Conversation>(`conversation?commit=${encodeURIComponent(selectedCommit.current)}`);
      selectedCommit.current = next.commit; setConversation(next); setNoteBody(next.note ?? '');
      setMode('idle');
      setSeenRevision(backgroundRevision); setDeferredRefresh(false);
      if (options.announce) setNotice('Latest updates are now shown.');
      requestAnimationFrame(() => window.scrollTo({ ...scroll, behavior: 'instant' }));
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (syncVersion > 0) setNotice(''); void refresh(); }, [syncVersion]);
  async function load(commit: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<Conversation>(`conversation?commit=${encodeURIComponent(commit)}`);
      if (next.commit !== conversation?.commit) {
        if (noteBody !== (conversation?.note ?? '') && !window.confirm('Open another change and discard your unsaved note text?')) return;
      }
      selectedCommit.current = next.commit; setConversation(next); setNoteBody(next.note ?? '');
      setMode('idle');
      requestAnimationFrame(() => document.getElementById('change-notes-heading')?.focus());
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function showAndOpenCommit(commit: string) {
    if (busy) return;
    await load(commit);
    setNotice(`Latest updates are now shown. Opened change ${commit.slice(0, 8)}.`);
  }

  function handleShowUpdates() {
    const firstUpdated = backgroundSummary?.sampleNoteCommits[0];
    if (firstUpdated && conversation?.commit !== firstUpdated) {
      void showAndOpenCommit(firstUpdated);
      return;
    }
    void refresh({ announce: true });
  }
  async function clearNote() {
    if (!conversation || busy) return;
    if (!window.confirm('Delete this commit note text? Previous text remains in Git history.')) return;
    setBusy(true); setError('');
    try {
      await api<Comment>('comments', { commit: conversation.commit, body: '', action: 'delete' });
      const next = await api<Conversation>(`conversation?commit=${encodeURIComponent(conversation.commit)}`);
      setConversation(next); setNoteBody('');
      setMode('idle');
      setNotice('Note deleted on this computer.'); onSaved();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const canShowEditor = mode !== 'idle';
  const canSave = mode === 'append' || mode === 'add'
    ? Boolean(noteBody.trim())
    : mode === 'edit'
      ? Boolean(noteBody.trim()) && noteBody !== (conversation?.note ?? '')
      : false;
  return <>
    <UpdatesNotice available={backgroundRevision > seenRevision || deferredRefresh} summary={backgroundSummary} editing={false} busy={busy}
      onShow={handleShowUpdates} onOpenCommit={commit => { void showAndOpenCommit(commit); }} />
    <ChangePicker initialCommit={initialCommit} conversation={conversation} syncVersion={syncVersion} backgroundRevision={backgroundRevision} busy={busy} onLoad={load} />
    <ErrorNotice message={error} onRetry={() => void refresh()} />
    <SavedNotice message={notice} onShare={onShare} />
    {busy && <p className="muted" role="status">Loading or saving notes…</p>}
    {conversation && <>
      <header className="review-title" id="change-notes-heading" tabIndex={-1}>
        <div className="eyebrow">NOTES FOR THIS SAVED CHANGE</div>
        <h3>{conversation.subject || 'Untitled change'}</h3>
        <p>These notes stay with this exact code snapshot.</p>
        <details className="technical-details"><summary>Git details</summary><p>Commit ID: <code>{conversation.commit}</code></p><p>Storage: <code>refs/notes/git-discuss</code></p></details>
      </header>
      <section className="card discussion" aria-label="Commit notes for this change">
        <div className="section-header"><h3>Note</h3>
          <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>Refresh notes</button></div>
        {!conversation.note && <div className="empty"><h3>No note yet</h3><p>Add a note for this saved change.</p></div>}
        {conversation.note && <MarkdownPreview value={conversation.note} className="card-markdown" />}
        {!conversation.note && <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => {
          setMode('add'); setNoteBody(''); requestAnimationFrame(() => document.getElementById('note-body')?.focus());
        }}>Add note</button></div>}
        {conversation.note && <div className="comment-actions">
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            setMode('edit'); setNoteBody(conversation.note ?? ''); requestAnimationFrame(() => document.getElementById('note-body')?.focus());
          }}>Edit</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            setMode('append'); setNoteBody(''); requestAnimationFrame(() => document.getElementById('note-body')?.focus());
          }}>Append</button>
          <button type="button" className="text-button danger-text" disabled={busy} onClick={() => void clearNote()}>Delete</button>
        </div>}
      </section>
      <SavedButUnshared error={shareError} onShare={onShare} />
      {canShowEditor && <form className="card composer" onSubmit={event => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        void submitNote(submitter?.value === 'share');
      }}>
        <fieldset disabled={busy}><MarkdownEditor id="note-body" value={noteBody} onChange={setNoteBody}
          label={mode === 'add' ? 'Add note text' : mode === 'append' ? 'Append note text' : 'Edit note text'}
          placeholder={mode === 'append' ? 'Write text to append to the current note' : 'Write note text for this commit'}
          maxLength={20000} rows={6} required hint="Markdown supported: bold, italic, links, code blocks, and emoji." />
          <CommentSubmitActions busy={busy} sharingNow={sharingNow} canSave={canSave} remote={sharing.remote} onChooseRemote={onShare} />
        </fieldset>
      </form>}
    </>}
  </>;
}
