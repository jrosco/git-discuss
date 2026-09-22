import type { Comment, Review } from './models.js';

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
