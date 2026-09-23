import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundUpdateStatus, BranchChoice, Comment, CommentMutation, Review } from '../core/models.js';
import { commentBody, isDeleted, isThreadResolved, recordVersion, threadComments, threadStatus, threadVersion } from '../core/changes.js';
import { errorMessage } from './api.js';
import { MarkdownEditor, MarkdownPreview } from './markdown.js';

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  let guidance = 'Your request could not be completed. Check the details below and try again.';
  if (/Cannot resolve|unavailable code/i.test(message)) guidance = 'That saved code could not be found on this computer. Choose another branch or check the commit ID.';
  else if (/write is active/i.test(message)) guidance = 'Another save or share is in progress. Wait a moment, then try again.';
  else if (/user.name|user.email|identity unknown|unable to auto-detect/i.test(message)) guidance = 'Git needs your name and email before it can save feedback. Ask your project maintainer to help configure your Git identity.';
  else if (/already has this base and head/i.test(message)) guidance = 'This comparison already uses the selected code.';
  else if (/changed since you opened|This item was deleted/i.test(message)) guidance = message;
  else if (/This thread is (resolved|already)/i.test(message)) guidance = message;
  else if (/Choose a branch to follow|already follows a branch|review follows a branch|remote-tracking branch has no configured remote/i.test(message)) guidance = message;
  else if (/no longer available locally/i.test(message)) guidance = 'This review is no longer on this computer. Return to the review list or get team updates. Your draft has been kept.';
  else if (/too large for the browser/i.test(message)) guidance = 'This code comparison is too large to show here. You can still discuss it; a Git user can inspect the complete changes using the command in the details.';
  else if (/Sync conflict|Note conflict|incompatible record|Unsupported|noncanonical/i.test(message)) guidance = 'Two copies of this discussion could not be combined automatically. Share these details with your teammate before trying again.';
  else if (/Sync upload failed/i.test(message)) guidance = 'Your discussions are saved on this computer, but sharing was not confirmed. Check your connection and access, then try sharing again.';
  else if (/Sync stopped|Authentication|Permission denied|not configured/i.test(message)) guidance = 'Could not connect or combine team feedback. Check your connection and repository access, or ask your project maintainer for help.';
  else if (/Cannot reach|full URL/i.test(message)) guidance = message;
  return <div className="error" role="alert">
    <strong>{guidance}</strong>
    {guidance !== message && <details><summary>Technical details</summary><pre>{message}</pre></details>}
    {onRetry && <button type="button" className="secondary-button" onClick={onRetry}>Try again</button>}
  </div>;
}

export function HelpLabel({ field, label, help }: { field: string; label: string; help: string }) {
  const [visible, setVisible] = useState(false);
  return <div className="field-label">
    <label htmlFor={field}>{label}</label>
    <span onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      <button type="button" className="help-button" aria-label={`Help: ${label}`} aria-describedby={`${field}-help`}
        onFocus={() => setVisible(true)} onBlur={() => setVisible(false)} onClick={() => setVisible(true)}
        onKeyDown={event => { if (event.key === 'Escape') setVisible(false); }}>?</button>
      <span id={`${field}-help`} role="tooltip" className="field-tooltip" hidden={!visible}>{help}</span>
    </span>
  </div>;
}

export function BranchOptions({ branches }: { branches: BranchChoice[] }) {
  return <>
    <option value="HEAD">My current saved code</option>
    <optgroup label="Branches on this computer">
      {branches.filter(branch => !branch.remote).map(branch => <option key={branch.ref} value={branch.ref}>
        {branch.name}{branch.current ? ' · currently open' : ''}
      </option>)}
    </optgroup>
    <optgroup label="Team branches · last downloaded">
      {branches.filter(branch => branch.remote).map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}
    </optgroup>
  </>;
}

export function CodeSource({ id, label, help, value, onChange, branches, savedOption }: {
  id: string; label: string; help: string; value: string; onChange: (value: string) => void; branches: BranchChoice[];
  savedOption?: { value: string; label: string };
}) {
  type Choice = { value: string; title: string; meta: string; custom?: boolean };
  const choices: Choice[] = [
    { value: 'HEAD', title: 'My current saved code', meta: 'Use the currently checked-out commit' },
    ...(savedOption ? [{ value: savedOption.value, title: savedOption.label, meta: 'Previously saved comparison code' }] : []),
    ...branches.map(branch => ({ value: branch.ref, title: branch.name,
      meta: `${branch.remote ? 'Team branch' : 'Local branch'} · ${branch.commit.slice(0, 8)}${branch.current ? ' · currently open' : ''}` })),
  ].filter((item, index, list) => list.findIndex(other => other.value === item.value) === index);
  if (value && !choices.some(item => item.value === value)) choices.unshift({ value, title: value, meta: 'Entered branch name or commit ID' });
  const selectedTitle = choices.find(item => item.value === value)?.title ?? '';
  const [query, setQuery] = useState(selectedTitle);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [visibleLimit, setVisibleLimit] = useState(9);
  const container = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const typed = query.trim();
  const pending = query !== selectedTitle;
  const search = pending ? typed.toLowerCase() : '';
  const filtered = choices.filter(item => !search || `${item.title} ${item.value} ${item.meta}`.toLowerCase().includes(search));
  const selectedChoice = filtered.find(item => item.value === value);
  const remaining = filtered.filter(item => item.value !== value);
  const exactChoice = choices.find(item => item.value === typed) ?? choices.find(item => item.title === typed);
  const customChoice: Choice | undefined = pending && typed && !exactChoice
    ? { value: typed, title: typed, meta: 'Use this branch name or commit ID', custom: true } : undefined;
  const suggestions = [...(selectedChoice ? [selectedChoice] : []), ...remaining.slice(0, visibleLimit), ...(customChoice ? [customChoice] : [])];
  const suggestionKey = suggestions.map(item => item.value).join('\0');

  useEffect(() => { setQuery(selectedTitle); }, [value, selectedTitle]);
  useEffect(() => { setActive(-1); setVisibleLimit(9); }, [search]);
  useEffect(() => { setActive(-1); }, [suggestionKey]);
  useEffect(() => {
    input.current?.setCustomValidity(pending ? 'Choose a result, or press Enter to use the branch name or commit ID you typed.' : '');
  }, [pending]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) { setOpen(false); setActive(-1); }
    };
    window.addEventListener('pointerdown', closeOutside);
    return () => window.removeEventListener('pointerdown', closeOutside);
  }, []);
  useEffect(() => { if (open && active >= 0) document.getElementById(`${id}-choice-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, open, id]);

  function choose(choice: Choice) {
    input.current?.setCustomValidity('');
    input.current?.focus();
    onChange(choice.value); setQuery(choice.title); setOpen(false); setActive(-1);
  }
  return <div className="form-field">
    <HelpLabel field={id} label={label} help={help} />
    <div className="ref-picker branch-picker" ref={container} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setActive(-1); }
    }}>
      <input id={id} ref={input} className="branch-picker-input" role="combobox" value={query} required maxLength={256}
        placeholder="Search branches or enter a commit ID" autoComplete="off"
        aria-describedby={`${id}-help ${id}-entry-hint`} aria-expanded={open} aria-controls={`${id}-suggestions`}
        aria-autocomplete="list" aria-activedescendant={open && suggestions[active] ? `${id}-choice-${active}` : undefined}
        onChange={event => { setQuery(event.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => { setOpen(true); setActive(-1); }} onClick={() => setOpen(true)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setActive(-1); setQuery(selectedTitle); return; }
          if (event.key === 'Enter') {
            event.preventDefault();
            const choice = open && suggestions[active] ? suggestions[active] : exactChoice ?? customChoice;
            if (choice) choose(choice);
            return;
          }
          if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault(); setOpen(true);
            setActive(index => event.key === 'ArrowDown' ? (index + 1) % suggestions.length : index > 0 ? index - 1 : suggestions.length - 1);
          }
        }} />
      {open && <ul id={`${id}-suggestions`} className="ref-suggestions" role="listbox" aria-label={`Choose ${label.toLowerCase()}`}>
        <li className="ref-suggestions-current"><strong>Current selection:</strong> {selectedTitle || 'None yet'}</li>
        {suggestions.map((item, index) => <li id={`${id}-choice-${index}`} key={item.value} role="option" aria-selected={active === index}>
          <button type="button" className={`ref-suggestion-card${item.value === value || active === index ? ' active' : ''}`}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
            <span className="change-title"><span>{item.custom ? <>Use <code>{item.title}</code></> : item.title}</span>
              {item.value === value && <span className="version-badge">Current</span>}</span>
            <span className="review-card-meta">{item.meta}</span>
          </button>
        </li>)}
        {filtered.length === 0 && <li className="ref-suggestions-empty">No matching saved branches. You can use the value you typed.</li>}
        {remaining.length > visibleLimit && <li className="ref-suggestions-footer"><button type="button" className="text-button"
          onMouseDown={event => event.preventDefault()} onClick={() => setVisibleLimit(current => current + 9)}>Show older results</button></li>}
      </ul>}
    </div>
    <small id={`${id}-entry-hint`} className="field-hint">{pending ? 'Choose a result, or press Enter to use your entry.' : 'Choose a branch, or type a commit ID and press Enter.'}</small>
  </div>;
}

export function useEditingGuard() {
  const [ids, setIds] = useState<string[]>([]);
  const onEditingChange = useCallback((id: string, editing: boolean) => {
    setIds(current => editing ? current.includes(id) ? current : [...current, id] : current.includes(id) ? current.filter(item => item !== id) : current);
  }, []);
  return { editing: ids.length > 0, onEditingChange };
}

export function UpdatesNotice({ available, editing, busy, onShow, summary, onOpenReview, onOpenCommit }: {
  available: boolean;
  editing: boolean;
  busy: boolean;
  onShow: () => void;
  summary: BackgroundUpdateStatus['latestChangeSummary'];
  onOpenReview?: (id: string) => void;
  onOpenCommit?: (id: string) => void;
}) {
  if (!available) return null;
  const reviewSamples = summary?.sampleReviewIds.map(id => ({ id, short: id.slice(0, 8) })) ?? [];
  const noteSamples = summary?.sampleNoteCommits.map(id => ({ id, short: id.slice(0, 8) })) ?? [];
  const listedReviewCount = reviewSamples.length;
  const extraReviewCount = Math.max(0, (summary?.reviewsUpdated ?? 0) - listedReviewCount);
  const heading = summary ?
    summary.notesUpdated && summary.reviewsUpdated > 0 ? 'New code or feedback available in Reviews and Change notes' :
      summary.reviewsUpdated > 0 ? 'New code or feedback available in Reviews' :
        summary.notesUpdated ? 'New feedback available in Change notes' :
          'New feedback available'
    : 'New feedback available';
  const detail = summary ?
    summary.notesUpdated && summary.reviewsUpdated > 0
      ? `${summary.reviewsUpdated} ${summary.reviewsUpdated === 1 ? 'review' : 'reviews'} updated and change notes updated.`
      : summary.reviewsUpdated > 0
        ? `${summary.reviewsUpdated} ${summary.reviewsUpdated === 1 ? 'review' : 'reviews'} updated.`
        : summary.notesUpdated
          ? 'Change notes updated.'
          : ''
    : '';
  const reviewList = listedReviewCount ?
    `Updated review IDs: ${reviewSamples.map(item => item.short).join(', ')}${extraReviewCount ? ` (+${extraReviewCount} more)` : ''}.`
    : '';
  const noteList = noteSamples.length ? `Updated change-note commits: ${noteSamples.map(item => item.short).join(', ')}.` : '';
  return <div className="updates-notice">
    <div><strong>{heading}</strong>
      {(detail || reviewList || noteList) && <p className="updates-summary"><strong>Most recent update{summary?.remote ? ` from ${summary.remote}` : ''}:</strong> {detail} {reviewList} {noteList}</p>}
      <small>{editing ? 'Finish or cancel your edit before showing updates.' : 'Drafts stay attached to the code you started discussing.'}</small>
      {onOpenReview && listedReviewCount > 0 && <div className="row">{reviewSamples.map(item =>
        <button key={item.id} type="button" className="text-button" disabled={editing || busy} onClick={() => onOpenReview(item.id)}>Open {item.short}</button>)}
      </div>}
      {onOpenCommit && noteSamples.length > 0 && <div className="row">{noteSamples.map(item =>
        <button key={item.id} type="button" className="text-button" disabled={editing || busy} onClick={() => onOpenCommit(item.id)}>Open {item.short}</button>)}
      </div>}
    </div>
    <button type="button" className="secondary-button" disabled={editing || busy} onClick={onShow}>Show updates</button>
  </div>;
}

export function Thread({ comment, comments, onReply, onChange, onEditingChange, onOpenVersion, pendingReplyId, parentResolved = false, versions, disabled = false }: {
  comment: Comment; comments: Comment[]; onReply: (comment: Comment) => void;
  onChange?: (comment: Comment, mutation: CommentMutation) => Promise<void>;
  onEditingChange?: (id: string, editing: boolean) => void;
  onOpenVersion?: (revisionId: string) => void;
  pendingReplyId?: string;
  parentResolved?: boolean;
  versions?: Review['revisions']; disabled?: boolean;
}) {
  const version = versions?.findIndex(item => 'revisionId' in comment && item.id === comment.revisionId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expectedVersion, setExpectedVersion] = useState(comment.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const deleted = isDeleted(comment);
  const root = !comment.replyTo;
  const resolved = root && isThreadResolved(comment, comments);
  const lastStatus = root ? threadStatus(comment) : undefined;
  const edits = comment.changes?.filter(change => change.kind === 'edit') ?? [];
  const descendantEdits = useEditingGuard();
  const reportChildEditing = useCallback((id: string, active: boolean) => {
    descendantEdits.onEditingChange(id, active); onEditingChange?.(id, active);
  }, [descendantEdits.onEditingChange, onEditingChange]);
  const pendingReply = root && Boolean(pendingReplyId && threadComments(comments, comment.id).some(item => item.id === pendingReplyId));
  const statusBlocked = editing || descendantEdits.editing || (!resolved && pendingReply);
  const collapsed = resolved && !expanded && !editing && !descendantEdits.editing && !pendingReply;
  const contentId = `thread-content-${comment.id}`;
  useEffect(() => {
    onEditingChange?.(comment.id, editing);
    return () => onEditingChange?.(comment.id, false);
  }, [comment.id, editing, onEditingChange]);
  async function change(mutation: CommentMutation) {
    if (!onChange) return;
    setSaving(true); setError('');
    try {
      await onChange(comment, mutation); setEditing(false);
      if (mutation.kind === 'resolve') setExpanded(false);
    }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return <article className={`comment${resolved ? ' resolved-thread' : ''}`} aria-label={`Comment by ${comment.author.name}`} data-comment-id={comment.id}>
    <div className="comment-header">
      <span className="avatar" aria-hidden="true">{comment.author.name.slice(0, 1).toUpperCase()}</span>
      <strong>{comment.author.name}</strong>
      <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
      {version !== undefined && version >= 0 && (onOpenVersion
        ? <button type="button" className="version-badge version-link" disabled={disabled || saving}
          aria-label={`Open code changes for commit ${comment.commit.slice(0, 8)}`} title={`Open the saved comparison for commit ${comment.commit}`}
          onClick={() => onOpenVersion(versions![version].id)}>Commit {comment.commit.slice(0, 8)} ↗</button>
        : <span className="version-badge">Commit {comment.commit.slice(0, 8)}</span>)}
    </div>
    {root && onChange && <div className="thread-controls">
      <div><span className={`thread-status${resolved ? ' is-resolved' : ''}`}>{resolved ? 'Resolved' : 'Open thread'}</span>
        {resolved && lastStatus && <small>Resolved by {lastStatus.author.name} · {new Date(lastStatus.createdAt).toLocaleString()}</small>}
        {!resolved && lastStatus?.kind === 'resolve' && <small>The thread changed since it was resolved.</small>}
        {statusBlocked && <small>Finish or cancel the draft in this thread before changing its status.</small>}
      </div>
      <div className="thread-control-actions">
        {resolved && <button type="button" className="text-button" aria-expanded={!collapsed} aria-controls={contentId}
          disabled={!collapsed && (editing || descendantEdits.editing || pendingReply)}
          onClick={() => setExpanded(current => !current)}>{collapsed ? 'Show discussion' : 'Hide discussion'}</button>}
        <button type="button" className="secondary-button" disabled={disabled || saving || statusBlocked}
          onClick={() => void change({ kind: resolved ? 'reopen' : 'resolve', expectedVersion: recordVersion(comment), expectedThread: threadVersion(comments, comment.id) })}>
          {resolved ? 'Reopen thread' : 'Resolve thread'}
        </button>
      </div>
    </div>}
    <ErrorNotice message={error} />
    <div className="thread-content" id={contentId} hidden={collapsed}>
    <div className={`comment-body${deleted ? ' deleted-comment' : ''}`}>
      <MarkdownPreview value={commentBody(comment)} />
    </div>
    {!deleted && edits.length > 0 && <details className="comment-history"><summary>Edited · View history</summary>
      <div className="comment-body"><strong>Original:</strong><MarkdownPreview value={comment.body} /></div>
      {edits.map(change => <div key={change.id}><small>{change.author.name} · {new Date(change.createdAt).toLocaleString()}</small>
        <div className="comment-body"><MarkdownPreview value={change.body} /></div></div>)}
    </details>}
    {root && lastStatus && <details className="comment-history"><summary>Resolution history</summary>
      {comment.changes?.filter(change => change.kind === 'resolve' || change.kind === 'reopen').map(change =>
        <p key={change.id}>{change.kind === 'resolve' ? 'Resolved' : 'Reopened'} by {change.author.name} · {new Date(change.createdAt).toLocaleString()}</p>)}
    </details>}
    {editing && <form className="comment-editor" onSubmit={event => { event.preventDefault(); void change({ kind: 'edit', body: draft, expectedVersion }); }}>
      <MarkdownEditor id={`edit-${comment.id}`} label="Edit comment" value={draft} onChange={setDraft} placeholder="Update your feedback"
        required maxLength={20000} rows={4} disabled={disabled || saving} autoFocus
        hint="Markdown supported: bold, italic, links, code blocks, and emoji." />
      <div className="form-actions"><button disabled={disabled || saving || deleted || !draft.trim()}>{saving ? 'Saving…' : 'Save changes'}</button>
        <button type="button" className="secondary-button" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>Cancel</button></div>
    </form>}
    {!deleted && !editing && <div className="comment-actions">
      <button type="button" className="text-button" disabled={disabled || saving || resolved || parentResolved}
        title={resolved || parentResolved ? 'Reopen this thread before replying' : undefined} onClick={() => onReply(comment)}>Reply</button>
      {onChange && <>
        <button type="button" className="text-button" disabled={disabled || saving} onClick={() => { setDraft(commentBody(comment)); setExpectedVersion(recordVersion(comment)); setEditing(true); setError(''); }}>Edit</button>
        <button type="button" className="text-button danger-text" disabled={disabled || saving} onClick={() => {
          if (window.confirm('Delete this comment? Replies will remain. The deletion will be shared the next time you share updates. Previous text remains in Git history.')) {
            void change({ kind: 'delete', expectedVersion: recordVersion(comment) });
          }
        }}>Delete</button>
      </>}
    </div>}
    {comments.filter(item => item.replyTo === comment.id).map(child =>
      <div className="replies" key={child.id}><Thread comment={child} comments={comments} onReply={onReply} onChange={onChange}
        onEditingChange={reportChildEditing} onOpenVersion={onOpenVersion} pendingReplyId={pendingReplyId} parentResolved={resolved || parentResolved} versions={versions} disabled={disabled} /></div>)}
    </div>
  </article>;
}

export function SavedNotice({ message, onShare }: { message: string; onShare: () => void }) {
  if (!message) return null;
  return <div className="notice" role="status"><span>{message}</span>{' '}
    <button type="button" className="text-button" onClick={onShare}>Share with your team →</button>
  </div>;
}

export function CommentSubmitActions({ busy, sharingNow, canSave, remote, onChooseRemote }: {
  busy: boolean; sharingNow: boolean; canSave: boolean; remote: string; onChooseRemote: () => void;
}) {
  return <div className="composer-footer">
    <div className="submission-help"><small>Save locally now, and share when you’re ready.</small>
      <small>{remote ? `Sharing sends all saved reviews and change notes to ${remote}.` : 'Choose a team repository to share now. You can still save locally.'}</small>
      {!remote && <button type="button" className="text-button" onClick={onChooseRemote}>Sharing settings</button>}
    </div>
    <div className="submission-actions">
      <button type="submit" name="action" value="local" className="secondary-button" disabled={busy || !canSave}>
        {busy && !sharingNow ? 'Saving…' : 'Save locally'}
      </button>
      <button type="submit" name="action" value="share" disabled={busy || !canSave || !remote}>
        {sharingNow ? 'Saving & sharing…' : 'Save & share now'}
      </button>
    </div>
  </div>;
}

export function SavedButUnshared({ error, onShare }: { error: string; onShare: () => void }) {
  if (!error) return null;
  return <div className="error" role="alert"><strong>Your comment was saved locally, but sharing was not confirmed.</strong>
    <p>You don’t need to post it again. Use Share & get updates to retry uploading your saved feedback.</p>
    <button type="button" className="secondary-button" onClick={onShare}>Go to sharing</button>
    <details><summary>Technical details</summary><pre>{error}</pre></details>
  </div>;
}
