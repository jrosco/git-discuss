import { useState } from 'react';
import type { BranchChoice, Comment, Review } from '../core/models.js';

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  let guidance = 'Your request could not be completed. Check the details below and try again.';
  if (/Cannot resolve|unavailable code/i.test(message)) guidance = 'That saved code could not be found on this computer. Choose another branch or check the commit ID.';
  else if (/write is active/i.test(message)) guidance = 'Another save or share is in progress. Wait a moment, then try again.';
  else if (/user.name|user.email|identity unknown|unable to auto-detect/i.test(message)) guidance = 'Git needs your name and email before it can save feedback. Ask your project maintainer to help configure your Git identity.';
  else if (/already has this base and head/i.test(message)) guidance = 'This version already uses the selected code. Choose updated code, or cancel to keep the existing version.';
  else if (/no longer available locally/i.test(message)) guidance = 'This review is no longer on this computer. Return to the review list or get team updates. Your draft has been kept.';
  else if (/too large for the browser/i.test(message)) guidance = 'This code comparison is too large to show here. You can still discuss it; a Git user can inspect the complete changes using the command in the details.';
  else if (/Sync conflict|incompatible record|Unsupported|noncanonical/i.test(message)) guidance = 'Two copies of this discussion could not be combined automatically. Share these details with your teammate before trying again.';
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
  const [manual, setManual] = useState(false);
  const known = value === 'HEAD' || value === savedOption?.value || branches.some(branch => branch.ref === value);
  const custom = manual || Boolean(value && !known);
  return <div className="form-field">
    <HelpLabel field={id} label={label} help={help} />
    <select id={id} value={custom ? '__custom__' : value} required aria-describedby={`${id}-help`}
      onChange={event => {
        const next = event.target.value;
        setManual(next === '__custom__');
        onChange(next === '__custom__' ? '' : next);
      }}>
      <option value="" disabled>Choose a branch…</option>
      {savedOption && <option value={savedOption.value}>{savedOption.label}</option>}
      <BranchOptions branches={branches} />
      <option value="__custom__">Enter a branch name or commit ID…</option>
    </select>
    {custom && <div className="custom-source">
      <label htmlFor={`${id}-custom`}>Branch name or commit ID</label>
      <input id={`${id}-custom`} value={value} onChange={event => onChange(event.target.value)} placeholder="For example: main, feature/login, or a commit ID" required maxLength={256} />
    </div>}
  </div>;
}

export function Thread({ comment, comments, onReply, versions, disabled = false }: {
  comment: Comment; comments: Comment[]; onReply: (comment: Comment) => void;
  versions?: Review['revisions']; disabled?: boolean;
}) {
  const version = versions?.findIndex(item => 'revisionId' in comment && item.id === comment.revisionId);
  return <article className="comment">
    <div className="comment-header">
      <span className="avatar" aria-hidden="true">{comment.author.name.slice(0, 1).toUpperCase()}</span>
      <strong>{comment.author.name}</strong>
      <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
      {version !== undefined && version >= 0 && <span className="version-badge">Version {version + 1}</span>}
    </div>
    <p className="comment-body">{comment.body}</p>
    <button type="button" className="text-button" disabled={disabled} onClick={() => onReply(comment)}>Reply</button>
    {comments.filter(item => item.replyTo === comment.id).map(child =>
      <div className="replies" key={child.id}><Thread comment={child} comments={comments} onReply={onReply} versions={versions} disabled={disabled} /></div>)}
  </article>;
}

export function SavedNotice({ message, onShare }: { message: string; onShare: () => void }) {
  if (!message) return null;
  return <div className="notice" role="status"><span>{message}</span>{' '}
    <button type="button" className="text-button" onClick={onShare}>Share with your team →</button>
  </div>;
}
