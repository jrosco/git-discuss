import { useEffect, useRef, useState } from 'react';
import type { BranchChoice, Comment, Review, RevisionDiff } from '../core/models.js';
import { api, errorMessage } from './api.js';
import { CodeSource, ErrorNotice, SavedNotice, Thread, UpdatesNotice, useEditingGuard } from './components.js';
import { commentBody, isDeleted, recordVersion, reviewTitle } from '../core/changes.js';

function DiffViewer({ reviewId, revisionId }: { reviewId: string; revisionId: string }) {
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDiff(null); setError('');
    void api<RevisionDiff>(`reviews/${reviewId}/revisions/${revisionId}/diff`).then(result => {
      if (active) setDiff(result);
    }).catch(error => { if (active) setError(errorMessage(error)); });
    return () => { active = false; };
  }, [reviewId, revisionId, attempt]);
  return <section className="card revision-diff" aria-label="Code changes">
    <div className="section-header"><h3>What changed?</h3><span className="muted">Read-only comparison</span></div>
    <p className="panel-help">Lines starting with <span className="diff-added">+</span> were added. Lines starting with <span className="diff-removed">−</span> were removed.</p>
    {!diff && !error && <p role="status" className="panel-help">Loading code changes…</p>}
    <ErrorNotice message={error} onRetry={() => setAttempt(value => value + 1)} />
    {diff && (diff.patch ? <pre className="diff-patch" tabIndex={0} aria-label="Changes between the comparison code and reviewed code"><code>
      {diff.patch.split('\n').map((line, index, lines) => <span key={index}
        className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' :
          line.startsWith('@@') || line.startsWith('diff --git') ? 'diff-heading' : undefined}>
        {line}{index < lines.length - 1 ? '\n' : ''}
      </span>)}
    </code></pre> : <div className="empty"><h3>No code differences</h3><p>The two saved snapshots contain the same code. You can still discuss them, or add a version using different comparison code.</p></div>)}
  </section>;
}

function VersionForm({ review, onSave, onCancel }: {
  review?: Review; onSave: (input: { title: string; base: string; head: string }) => Promise<void>; onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [base, setBase] = useState(review?.revisions[review.revisions.length - 1].base ?? '');
  const [head, setHead] = useState('HEAD');
  const [branches, setBranches] = useState<BranchChoice[]>([]);
  const [branchError, setBranchError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<BranchChoice[]>('branches').then(setBranches).catch(error => setBranchError(errorMessage(error)));
  }, []);
  return <form className="card guided-form" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('');
    void onSave({ title, base, head }).catch(error => setError(errorMessage(error))).finally(() => setBusy(false));
  }}>
    <fieldset disabled={busy}>
      <h3>{review ? 'Add updated code' : 'Start a review'}</h3>
      <p className="form-intro">{review ? 'Save another version in this review. Previous versions and feedback stay available.' : 'Give your review a name, then choose the code you want feedback on.'}</p>
      {!review && <div className="form-field"><label htmlFor="review-title">What would you like feedback on?</label>
        <input id="review-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="For example: Make the login flow easier to use" required maxLength={256} autoFocus />
      </div>}
      <div className="source-fields">
        <CodeSource id="review-head" label="Changes to review" value={head} onChange={setHead} branches={branches}
          help="Choose the branch containing the work you want feedback on. A branch is a named line of work. ‘My current saved code’ uses the latest commit currently open in this project (Git calls this HEAD)." />
        <CodeSource id="review-base" label="Compare with" value={base} onChange={setBase} branches={branches}
          savedOption={review ? { value: review.revisions[review.revisions.length - 1].base, label: 'Same starting code as the previous version' } : undefined}
          help="Choose the starting code to compare against—usually your team’s main branch. The review shows the difference between this code and the changes you selected. Git calls this the base." />
      </div>
      <p className="field-hint">Not sure what to compare with? Ask the change’s author which branch to use, often <code>main</code>.</p>
      <p className="field-hint">Only changes already saved in Git are included. Edits in your working files are not included until committed.</p>
      {base && base === head && <p className="inline-hint">You selected the same code on both sides. This review will have no code differences.</p>}
      {branchError && <div className="inline-hint">The branch list could not be loaded. You can still enter a branch name or commit ID.<details><summary>Technical details</summary>{branchError}</details></div>}
      <ErrorNotice message={error} />
      <div className="form-actions"><button disabled={busy || !base.trim() || !head.trim() || (!review && !title.trim())}>{busy ? 'Saving…' : review ? 'Save new version' : 'Create review'}</button>
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <small>Saved on this computer first</small>
      </div>
    </fieldset>
  </form>;
}

export function ReviewsWorkspace({ syncVersion, backgroundRevision, onSaved, onShare }: {
  syncVersion: number; backgroundRevision: number; onSaved: () => void; onShare: () => void;
}) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const selectedId = useRef<string | null>(null);
  const [view, setView] = useState<'list' | 'create' | 'review'>('list');
  const [revisionId, setRevisionId] = useState('');
  const [tab, setTab] = useState<'discussion' | 'changes'>('discussion');
  const [addingVersion, setAddingVersion] = useState(false);
  const [filter, setFilter] = useState('');
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleVersion, setTitleVersion] = useState('');
  const [seenRevision, setSeenRevision] = useState(0);
  const [deferredRefresh, setDeferredRefresh] = useState(false);
  const editGuard = useEditingGuard();
  const hasEdits = editGuard.editing || editingTitle || addingVersion || view === 'create';

  function remember(next: Review) {
    setReviews(current => [...current.filter(item => item.id !== next.id), next]);
    setReview(next); selectedId.current = next.id;
  }
  async function refresh() {
    if (hasEdits) { setDeferredRefresh(true); return; }
    const scroll = { left: window.scrollX, top: window.scrollY };
    setBusy(true); setError('');
    try {
      const items = await api<Review[]>('reviews');
      setReviews(items);
      const current = items.find(item => item.id === selectedId.current);
      if (current) setReview(current);
      else if (selectedId.current) setReview(await api<Review>(`reviews/${selectedId.current}`));
      setSeenRevision(backgroundRevision); setDeferredRefresh(false);
      requestAnimationFrame(() => window.scrollTo({ ...scroll, behavior: 'instant' }));
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (syncVersion > 0) setNotice(''); void refresh(); }, [syncVersion]);

  async function openReview(id: string) {
    if (id !== review?.id && body && !window.confirm('Open another review and discard your unsaved feedback?')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<Review>(`reviews/${id}`);
      if (id !== review?.id) {
        setRevisionId(next.revisions[next.revisions.length - 1].id); setBody(''); setReplyTo(null); setTab('discussion');
      }
      remember(next); setView('review'); setAddingVersion(false); setEditingTitle(false);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  function chooseVersion(id: string) {
    if (id !== revisionId && body && !window.confirm('Change the version you are discussing and discard your unsaved feedback?')) return;
    setRevisionId(id); setBody(''); setReplyTo(null);
  }
  const versionIndex = review?.revisions.findIndex(item => item.id === revisionId) ?? -1;
  const version = review?.revisions[versionIndex];
  const latest = review?.revisions[review.revisions.length - 1];

  return <>
    <UpdatesNotice available={backgroundRevision > seenRevision || deferredRefresh} editing={hasEdits} busy={busy} onShow={() => void refresh()} />
    <ErrorNotice message={error} onRetry={() => void refresh()} />
    <SavedNotice message={notice} onShare={onShare} />
    {view === 'list' && <>
      <div className="workspace-toolbar"><h3>Your reviews <span className="count">{reviews.length}</span></h3>
        <div className="row"><button className="secondary-button" disabled={busy} onClick={() => void refresh()}>Refresh list</button>
          <button disabled={busy} onClick={() => {
            if (body && !window.confirm('Start a new review and discard your unsaved feedback on the previous review?')) return;
            setBody(''); setReplyTo(null); setView('create'); setError(''); setNotice('');
          }}>Start a review</button></div>
      </div>
      {busy && <p role="status" className="muted">Loading reviews…</p>}
      {!busy && reviews.length === 0 && <div className="card empty onboarding">
        <h3>A place for feedback that stays with your code</h3>
        <p>Start a review for work you want to discuss, or get reviews your teammates have already shared.</p>
        <ol className="getting-started"><li><strong>Choose the changes</strong><span>Pick your work and the code to compare it with.</span></li><li><strong>Leave feedback</strong><span>Ask questions and explain decisions.</span></li><li><strong>Share with your team</strong><span>Send saved feedback and receive their replies.</span></li></ol>
        <button type="button" className="secondary-button" onClick={onShare}>Go to team sharing</button>
      </div>}
      {reviews.length > 0 && <>
        <label className="sr-only" htmlFor="review-search">Find a review by title or author</label>
        <input className="search-input" id="review-search" placeholder="Find a review by title or author…" value={filter} onChange={event => setFilter(event.target.value)} />
        <div className="review-list">{reviews.filter(item => `${reviewTitle(item)} ${item.author.name}`.toLowerCase().includes(filter.toLowerCase()))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(item => <button type="button" className="review-card" key={item.id} disabled={busy} onClick={() => void openReview(item.id)}>
            <span className="review-card-title">{reviewTitle(item)}<span aria-hidden="true">→</span></span>
            <span className="review-card-meta">Started by {item.author.name} · {new Date(item.createdAt).toLocaleDateString()}</span>
            <span className="review-card-meta">{item.revisions.length} {item.revisions.length === 1 ? 'version' : 'versions'} · {item.comments.length} {item.comments.length === 1 ? 'comment' : 'comments'}</span>
            {item.id === review?.id && body && <span className="version-badge">You have draft feedback</span>}
          </button>)}</div>
        {!reviews.some(item => `${reviewTitle(item)} ${item.author.name}`.toLowerCase().includes(filter.toLowerCase())) && <p className="empty">No reviews match “{filter}”. Try another title or author.</p>}
      </>}
    </>}
    {view === 'create' && <VersionForm onCancel={() => setView('list')} onSave={async input => {
      setBusy(true);
      try {
        const next = await api<Review>('reviews', input);
        remember(next); setRevisionId(next.revisions[0].id); setTab('changes'); setView('review');
        setNotice('Review created on this computer.'); onSaved();
      } finally { setBusy(false); }
    }} />}
    {view === 'review' && review && isDeleted(review) && <section className="card empty"><h3>This review was deleted</h3><p>The deletion is saved in the review history and will be kept when sharing updates.</p>
      {body && <><label htmlFor="deleted-review-draft">Your unsaved feedback is still here to copy</label><textarea id="deleted-review-draft" value={body} readOnly rows={4} /></>}
      <button type="button" className="secondary-button" onClick={() => { setView('list'); selectedId.current = null; }}>← All reviews</button>
    </section>}
    {view === 'review' && review && !isDeleted(review) && <>
      <div className="workspace-toolbar"><button type="button" className="text-button" disabled={busy} onClick={() => { setView('list'); setAddingVersion(false); }}>← All reviews</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>Refresh feedback</button></div>
      <header className="pull-request-header"><h2>{reviewTitle(review)}</h2>
        <div className="review-summary"><span className="review-kind">Review</span><p><strong>{review.author.name}</strong> started this review on {new Date(review.createdAt).toLocaleDateString()} · {review.revisions.length} {review.revisions.length === 1 ? 'version' : 'versions'}</p></div>
      </header>
      <div className="review-management"><button type="button" className="secondary-button" disabled={busy || editingTitle} onClick={() => {
        setTitleDraft(reviewTitle(review)); setTitleVersion(recordVersion(review)); setEditingTitle(true);
      }}>Edit title</button>
        <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => {
          if (!window.confirm('Delete this review and its discussion? It will disappear from the review list and the deletion will be shared with your team. Previous content remains in Git history.')) return;
          setBusy(true); setError('');
          void api<Review>(`reviews/${review.id}/change`, { kind: 'delete', expectedVersion: recordVersion(review) }).then(() => {
            setReviews(current => current.filter(item => item.id !== review.id)); setReview(null); selectedId.current = null;
            setView('list'); setBody(''); setReplyTo(null); setEditingTitle(false); setAddingVersion(false);
            setNotice('Review deleted on this computer.'); onSaved();
          }).catch(error => setError(errorMessage(error))).finally(() => setBusy(false));
        }}>Delete review</button>
      </div>
      {editingTitle && <form className="card guided-form" onSubmit={event => {
        event.preventDefault(); setBusy(true); setError('');
        void api<Review>(`reviews/${review.id}/change`, { kind: 'rename', title: titleDraft, expectedVersion: titleVersion }).then(next => {
          remember(next); setEditingTitle(false); setNotice('Review title updated on this computer.'); onSaved();
        }).catch(error => setError(errorMessage(error))).finally(() => setBusy(false));
      }}><label htmlFor="edit-review-title">Review title</label><input id="edit-review-title" value={titleDraft} disabled={busy} onChange={event => setTitleDraft(event.target.value)} required maxLength={256} autoFocus />
        <div className="form-actions"><button disabled={busy || !titleDraft.trim()}>Save title</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setEditingTitle(false)}>Cancel</button></div>
      </form>}
      <div className="view-switch" role="group" aria-label="Review view">
        <button type="button" aria-pressed={tab === 'discussion'} aria-controls="review-discussion" onClick={() => setTab('discussion')}>Discussion <span className="count">{review.comments.length}</span></button>
        <button type="button" aria-pressed={tab === 'changes'} aria-controls="review-changes" onClick={() => setTab('changes')}>Code changes</button>
      </div>
      <div className="pull-request-layout">
      <aside className="review-sidebar" aria-label="Review details">
        <section className="version-picker" aria-label="Review version">
          <label htmlFor="review-version">Which version are you reviewing?</label>
          <select id="review-version" value={revisionId} disabled={busy || addingVersion} onChange={event => chooseVersion(event.target.value)}>
            {review.revisions.map((item, index) => <option key={item.id} value={item.id}>Version {index + 1}{index === review.revisions.length - 1 ? ' · latest' : ''}</option>)}
          </select>
          {version && <p className="field-hint">Saved by {version.author.name}<br />{new Date(version.createdAt).toLocaleDateString()}</p>}
          <button type="button" className="secondary-button" disabled={busy || addingVersion} onClick={() => setAddingVersion(true)}>Add updated code</button>
          {latest && latest.id !== revisionId && <div className="inline-hint">You’re looking at an earlier version. <button type="button" className="text-button" disabled={busy || addingVersion} onClick={() => chooseVersion(latest.id)}>View latest version</button></div>}
        </section>
        <section className="sidebar-section"><h3>About this discussion</h3><p>Feedback from all versions stays together. New comments refer to <strong>version {versionIndex + 1}</strong>.</p></section>
        <details className="technical-details"><summary>Git details & IDs</summary><dl><dt>Review ID</dt><dd><code>{review.id}</code></dd><dt>Version ID</dt><dd><code>{revisionId}</code></dd><dt>Comparison commit (base)</dt><dd><code>{version?.base}</code></dd><dt>Reviewed commit (head)</dt><dd><code>{version?.head}</code></dd></dl></details>
        {review.changes?.length && <details className="technical-details"><summary>Title history</summary><p>Original: {review.title}</p>{review.changes.map(change => <p key={change.id}>{change.kind === 'rename' ? change.title : 'Deleted'} · {change.author.name} · {new Date(change.createdAt).toLocaleString()}</p>)}</details>}
      </aside>
      <div className="review-main">
      {addingVersion && <VersionForm review={review} onCancel={() => setAddingVersion(false)} onSave={async input => {
        setBusy(true);
        try {
          const next = await api<Review>(`reviews/${review.id}/revisions`, { base: input.base, head: input.head });
          remember(next); setAddingVersion(false); setNotice(`Version ${next.revisions.length} saved. You’re still viewing version ${versionIndex + 1}; your feedback draft stays with it.`); onSaved();
        } finally { setBusy(false); }
      }} />}
      <div id="review-changes" hidden={tab !== 'changes'}>{version && <DiffViewer key={`${review.id}/${revisionId}`} reviewId={review.id} revisionId={revisionId} />}
        <button type="button" className="secondary-button" onClick={() => { setTab('discussion'); requestAnimationFrame(() => document.getElementById('review-body')?.focus()); }}>Discuss these changes →</button>
      </div>
      <div id="review-discussion" hidden={tab !== 'discussion'}>
        <section className="discussion review-timeline" aria-label="Review discussion">
          <div className="section-header"><h3>Discussion</h3><span className="muted">Feedback from all versions</span></div>
          {review.comments.length === 0 && <div className="empty"><h3>What should your teammates know?</h3><p>Ask a question, explain a decision, or suggest an improvement.</p></div>}
          {review.comments.filter(item => !item.replyTo).map(comment => <Thread key={comment.id} comment={comment} comments={review.comments} versions={review.revisions} disabled={busy}
            onEditingChange={editGuard.onEditingChange}
            onChange={async (item, mutation) => {
              setBusy(true);
              try {
                const next = await api<Review>(`reviews/${review.id}/comments/${item.id}/change`, mutation);
                remember(next); if (replyTo?.id === item.id) setReplyTo(mutation.kind === 'delete' ? null : next.comments.find(comment => comment.id === item.id) ?? null);
                setNotice(mutation.kind === 'delete' ? 'Comment deleted on this computer.' : 'Comment updated on this computer.'); onSaved();
              } finally { setBusy(false); }
            }}
            onReply={item => { setReplyTo(item); document.getElementById('review-body')?.focus(); }} />)}
        </section>
        <form className="card composer" onSubmit={event => {
          event.preventDefault(); setBusy(true); setError(''); setNotice('');
          void api<Review['comments'][number]>(`reviews/${review.id}/comments`, { revisionId, body, replyTo: replyTo?.id ?? null }).then(comment => {
            remember({ ...review, comments: [...review.comments, comment] }); setBody(''); setReplyTo(null); setNotice('Feedback saved on this computer.'); onSaved();
          }).catch(error => setError(errorMessage(error))).finally(() => setBusy(false));
        }}>
          <fieldset disabled={busy}><label htmlFor="review-body">{replyTo ? `Reply to ${replyTo.author.name}` : 'Add your feedback'}</label>
            <p className="field-hint">Your {replyTo ? 'reply' : 'comment'} will refer to <strong>version {versionIndex + 1}</strong>.</p>
            {replyTo && <div className="reply-context"><p>{commentBody(replyTo)}</p><button type="button" className="text-button" onClick={() => setReplyTo(null)}>Cancel reply</button></div>}
            <textarea id="review-body" value={body} onChange={event => setBody(event.target.value)} placeholder="What works well? What could be clearer?" required maxLength={20000} rows={5} />
            <div className="composer-footer"><small>Saved here first. Share when you’re ready.</small><button disabled={busy || !body.trim()}>{busy ? 'Saving…' : replyTo ? 'Save reply' : 'Save feedback'}</button></div>
          </fieldset>
        </form>
      </div>
      </div>
      </div>
    </>}
  </>;
}
