import type { Comment, Review } from './models.js';

export const MAX_COMMIT_NOTE_LENGTH = 100000;

export function isDeleted(record: { changes?: { kind: string }[] }): boolean {
  return record.changes?.some(change => change.kind === 'delete') ?? false;
}

export function activeCommentCount(comments: Comment[]): number {
  return comments.filter(comment => !isDeleted(comment)).length;
}

export function recordVersion(record: { id: string; changes?: { id: string }[] }): string {
  return record.changes?.[record.changes.length - 1]?.id ?? record.id;
}

export function commentBody(comment: Comment): string {
  if (isDeleted(comment)) return 'This comment was deleted.';
  return [...(comment.changes ?? [])].reverse().find(change => change.kind === 'edit')?.body ?? comment.body;
}

export function reviewTitle(review: Review): string {
  return [...(review.changes ?? [])].reverse().find(change => change.kind === 'rename')?.title ?? review.title;
}

export function threadRoot<T extends Comment>(comments: T[], commentId: string): T | undefined {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const seen = new Set<string>();
  let comment = byId.get(commentId);
  while (comment?.replyTo) {
    if (seen.has(comment.id)) return undefined;
    seen.add(comment.id); comment = byId.get(comment.replyTo);
  }
  return comment;
}

export function threadComments<T extends Comment>(comments: T[], rootId: string): T[] {
  // Validated discussion arrays always put a parent before its replies.
  const ids = new Set([rootId]);
  return comments.filter(comment => {
    if (comment.id === rootId || (comment.replyTo && ids.has(comment.replyTo))) {
      ids.add(comment.id); return true;
    }
    return false;
  });
}

export function threadVersion(comments: Comment[], rootId: string): string {
  // Resolution itself does not change content. New comments, edits, and deletions do.
  return threadComments(comments, rootId).map(comment => {
    const contentChange = [...(comment.changes ?? [])].reverse().find(change => change.kind === 'edit' || change.kind === 'delete');
    return `${comment.id}:${contentChange?.id ?? comment.id}`;
  }).sort().join(',');
}

export function threadStatus(comment: Comment) {
  return [...(comment.changes ?? [])].reverse().find(change => change.kind === 'resolve' || change.kind === 'reopen');
}

export function isThreadResolved(comment: Comment, comments: Comment[]): boolean {
  if (comment.replyTo) return false;
  const status = threadStatus(comment);
  return status?.kind === 'resolve' && status.threadVersion === threadVersion(comments, comment.id);
}
