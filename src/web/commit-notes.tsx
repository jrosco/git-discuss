import { useEffect, useRef, useState } from 'react';
import type { BranchChoice, CommitPage, Comment, Conversation } from '../core/models.js';
import { api, errorMessage } from './api.js';
import { BranchOptions, ErrorNotice, SavedNotice, Thread } from './components.js';

function ChangePicker({ initialCommit, currentCommit, busy, onLoad }: {
  initialCommit: string; currentCommit?: string; busy: boolean; onLoad: (ref: string) => Promise<void>;
}) {
  const [branches, setBranches] = useState<BranchChoice[]>([]);
  const [branch, setBranch] = useState(initialCommit);
  const [customRef, setCustomRef] = useState('');
  const [history, setHistory] = useState<CommitPage | null>(null);
  const [browsing, setBrowsing] = useState(true);
  const [error, setError] = useState('');
  async function browse(nextBranch: string) {
    setBrowsing(true); setError('');
    try {
      const [choices, page] = await Promise.all([
        api<BranchChoice[]>('branches'), api<CommitPage>(`commits?ref=${encodeURIComponent(nextBranch)}`),
      ]);
      setBranches(choices); setHistory(page); setBranch(nextBranch);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBrowsing(false); }
  }
  useEffect(() => { void browse(initialCommit); }, [initialCommit]);
  async function loadOlder() {
    if (!history || history.nextOffset === null) return;
    setBrowsing(true); setError('');
    try {
      const page = await api<CommitPage>(`commits?ref=${history.tip}&offset=${history.nextOffset}`);
      setHistory({ ...page, commits: [...history.commits, ...page.commits] });
    } catch (error) { setError(errorMessage(error)); }
    finally { setBrowsing(false); }
  }
  const disabled = busy || browsing;
  return <section className="card change-picker" aria-label="Find a saved change">
    <h3>Choose a saved change</h3>
    <p className="form-intro">A saved change is called a <strong>commit</strong> in Git. Open one below to read or leave a note.</p>
    <label htmlFor="notes-branch">Where should we look?</label>
    <div className="row"><select id="notes-branch" value={branch} disabled={disabled} onChange={event => void browse(event.target.value)}>
      <BranchOptions branches={branches} />
      {branch !== 'HEAD' && !branches.some(item => item.ref === branch) && <option value={branch}>Starting code · {branch}</option>}
    </select><button type="button" className="secondary-button" disabled={disabled} onClick={() => void browse(branch)}>Refresh list</button></div>
    <p className="field-hint">Branches are named lines of work. Team branches show the code last downloaded to this computer.</p>
    <ErrorNotice message={error} onRetry={() => void browse(branch)} />
    {browsing && <p role="status" className="muted">Finding saved changes…</p>}
    {history && <>
      <ul className="change-list" aria-label="Saved changes, newest first">{history.commits.map(item => <li key={item.commit}>
        <button type="button" className="change-card" disabled={disabled} aria-current={currentCommit === item.commit ? 'true' : undefined} onClick={() => void onLoad(item.commit)}>
          <span className="change-title">{item.subject || 'Untitled change'}{currentCommit === item.commit && <span className="version-badge">Open</span>}</span>
          <span className="review-card-meta">{item.author} · {new Date(item.authoredAt).toLocaleDateString()} <code>{item.commit.slice(0, 8)}</code></span>
        </button>
      </li>)}</ul>
      <div className="commit-history-footer"><small>{history.commits.length} saved changes{history.nextOffset === null ? ' · End of history' : ''}</small>
        {history.nextOffset !== null && <button type="button" className="text-button" disabled={disabled} onClick={() => void loadOlder()}>Show older changes</button>}</div>
    </>}
    <details className="technical-details"><summary>Have a specific commit ID or branch?</summary>
      <form onSubmit={event => { event.preventDefault(); void onLoad(customRef); }}>
        <label htmlFor="custom-commit">Commit ID or branch name</label>
        <div className="row"><input id="custom-commit" disabled={disabled} value={customRef} onChange={event => setCustomRef(event.target.value)} required maxLength={256} placeholder="Paste a commit ID or enter a branch name" />
          <button disabled={disabled || !customRef.trim()}>Open notes</button></div>
      </form>
    </details>
  </section>;
}

export function CommitNotesWorkspace({ initialCommit, syncVersion, onSaved, onShare }: {
  initialCommit: string; syncVersion: number; onSaved: () => void; onShare: () => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const selectedCommit = useRef(initialCommit);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  async function refresh() {
    setBusy(true); setError('');
    try {
      const next = await api<Conversation>(`conversation?commit=${encodeURIComponent(selectedCommit.current)}`);
      selectedCommit.current = next.commit; setConversation(next);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (syncVersion > 0) setNotice(''); void refresh(); }, [syncVersion]);
  async function load(commit: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<Conversation>(`conversation?commit=${encodeURIComponent(commit)}`);
      if (next.commit !== conversation?.commit) {
        if (body && !window.confirm('Open another change and discard your unsaved note?')) return;
        setBody(''); setReplyTo(null);
      }
      selectedCommit.current = next.commit; setConversation(next);
      requestAnimationFrame(() => document.getElementById('change-notes-heading')?.focus());
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <>
    <ChangePicker initialCommit={initialCommit} currentCommit={conversation?.commit} busy={busy} onLoad={load} />
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
      <section className="card discussion" aria-label="Notes on this change">
        <div className="section-header"><h3>Notes <span className="count">{conversation.comments.length}</span></h3>
          <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>Refresh notes</button></div>
        {conversation.comments.length === 0 && <div className="empty"><h3>No notes yet</h3><p>Capture a question or explain a decision about this saved change.</p></div>}
        {conversation.comments.filter(comment => !comment.replyTo).map(comment => <Thread key={comment.id} comment={comment} comments={conversation.comments} disabled={busy}
          onReply={item => { setReplyTo(item); document.getElementById('note-body')?.focus(); }} />)}
      </section>
      <form className="card composer" onSubmit={event => {
        event.preventDefault(); setBusy(true); setError(''); setNotice('');
        void api<Comment>('comments', { commit: conversation.commit, body, replyTo: replyTo?.id ?? null }).then(comment => {
          setConversation({ ...conversation, comments: [...conversation.comments, comment] }); setBody(''); setReplyTo(null);
          setNotice('Note saved on this computer.'); onSaved();
        }).catch(error => setError(errorMessage(error))).finally(() => setBusy(false));
      }}>
        <fieldset disabled={busy}><label htmlFor="note-body">{replyTo ? `Reply to ${replyTo.author.name}` : 'Leave a note'}</label>
          {replyTo && <div className="reply-context"><p>{replyTo.body}</p><button type="button" className="text-button" onClick={() => setReplyTo(null)}>Cancel reply</button></div>}
          <textarea id="note-body" value={body} onChange={event => setBody(event.target.value)} placeholder="What should the next person know about this change?" required maxLength={20000} rows={5} />
          <div className="composer-footer"><small>Saved here first. Share when you’re ready.</small><button disabled={busy || !body.trim()}>{busy ? 'Saving…' : replyTo ? 'Save reply' : 'Save note'}</button></div>
        </fieldset>
      </form>
    </>}
  </>;
}
