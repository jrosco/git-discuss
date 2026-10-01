import { z } from 'zod';
import { MAX_COMMIT_NOTE_LENGTH } from './changes.js';

const changeMetadata = {
  id: z.uuid(), author: z.object({ name: z.string().min(1), email: z.string().min(1) }), createdAt: z.iso.datetime(),
};
const threadVersionSchema = z.string().min(1).max(1000000);
export const commentChangeSchema = z.discriminatedUnion('kind', [
  z.object({ ...changeMetadata, kind: z.literal('edit'), body: z.string().trim().min(1).max(20000) }),
  z.object({ ...changeMetadata, kind: z.literal('delete') }),
  z.object({ ...changeMetadata, kind: z.literal('resolve'), threadVersion: threadVersionSchema }),
  z.object({ ...changeMetadata, kind: z.literal('reopen') }),
]);
export const reviewChangeSchema = z.discriminatedUnion('kind', [
  z.object({ ...changeMetadata, kind: z.literal('rename'), title: z.string().trim().min(1).max(256) }),
  z.object({ ...changeMetadata, kind: z.literal('delete') }),
]);
const uniqueChanges = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;

export const commentSchema = z.object({
  schema: z.union([z.literal(1), z.literal(2)]),
  type: z.literal('comment'),
  id: z.uuid(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  author: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  createdAt: z.iso.datetime(),
  replyTo: z.uuid().nullable(),
  body: z.string().trim().min(1).max(20000),
  changes: z.array(commentChangeSchema).min(1).refine(uniqueChanges, 'Duplicate change ID.').optional(),
});

export const addCommentSchema = z.object({
  commit: z.string().min(1).max(256),
  body: z.string().max(MAX_COMMIT_NOTE_LENGTH).default(''),
  action: z.enum(['set', 'add', 'edit', 'append', 'delete']).default('set'),
  expectedVersion: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable().optional(),
}).strict();

export type Comment = z.infer<typeof commentSchema>;
export type AddComment = z.input<typeof addCommentSchema>;
export interface CommitDetails {
  author: { name: string; email: string };
  authoredAt: string;
  committer: { name: string; email: string };
  committedAt: string;
  tree: string;
  parents: string[];
}

export interface Conversation {
  commit: string;
  subject: string;
  comments: Comment[];
  note: string | null;
  noteVersion: string | null;
  commitDetails: CommitDetails;
}

export interface SavedCommitNote {
  id: string;
  commit: string;
  author: Comment['author'];
  createdAt: string;
  body: string;
  note: string | null;
  noteVersion: string | null;
}

const commitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const trackedBranchSchema = z.string().min(12).max(256)
  .regex(/^refs\/heads\/[^\x00-\x20\x7f~^:?*[\\\]]+$/)
  .refine(value => !value.includes('..') && !value.includes('@{') && !value.endsWith('.') &&
    value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')), 'Invalid tracked branch ref.');
export const trackingSchema = z.object({ branch: trackedBranchSchema, base: commitId, initialHead: commitId, initialRemoteHead: commitId.optional() }).strict();
export const revisionSchema = z.object({
  id: z.uuid(), base: commitId, head: commitId,
  author: commentSchema.shape.author, createdAt: z.iso.datetime(),
  subject: z.string().optional(),
  source: z.literal('branch').optional(),
});
export const reviewCommentSchema = commentSchema.extend({ revisionId: z.uuid() });
export const reviewSchema = z.object({
  schema: z.union([z.literal(1), z.literal(2), z.literal(3)]), type: z.literal('review'), id: z.uuid(),
  title: z.string().trim().min(1).max(256),
  author: commentSchema.shape.author, createdAt: z.iso.datetime(),
  revisions: z.array(revisionSchema).min(1),
  comments: z.array(reviewCommentSchema),
  changes: z.array(reviewChangeSchema).min(1).refine(uniqueChanges, 'Duplicate change ID.').optional(),
  tracking: trackingSchema.optional(),
}).superRefine((review, context) => {
  if (review.tracking && (review.schema !== 3 || !review.revisions.some(item => item.base === review.tracking!.base && item.head === review.tracking!.initialHead))) {
    context.addIssue({ code: 'custom', message: 'Tracked reviews require schema 3 and a retained initial comparison.' });
  }
  if (review.revisions.some(item => item.source === 'branch') && !review.tracking) {
    context.addIssue({ code: 'custom', message: 'Automatic code snapshots require branch tracking.' });
  }
  const revisions = new Map(review.revisions.map(revision => [revision.id, revision]));
  const comments = new Set<string>();
  if (revisions.size !== review.revisions.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate revision ID.' });
  }
  for (const comment of review.comments) {
    if (comments.has(comment.id) || revisions.get(comment.revisionId)?.head !== comment.commit ||
        (comment.replyTo && !comments.has(comment.replyTo))) {
      context.addIssue({ code: 'custom', message: 'Invalid review comment history.' });
    }
    if (comment.replyTo && comment.changes?.some(change => change.kind === 'resolve' || change.kind === 'reopen')) {
      context.addIssue({ code: 'custom', message: 'Thread resolution belongs to the first comment, not a reply.' });
    }
    comments.add(comment.id);
  }
});
export const revisionInputSchema = z.object({
  base: z.string().min(1).max(256), head: z.string().min(1).max(256),
});
export const createReviewSchema = revisionInputSchema.extend({
  title: z.string().trim().min(1).max(256),
  // Older API consumers keep pinned comparisons. The web UI and CLI opt into tracking by default.
  followBranch: z.boolean().default(false),
  trackingRemote: z.string().min(1).max(256).optional(),
});
export const followReviewSchema = z.object({ head: z.string().min(1).max(256), trackingRemote: z.string().min(1).max(256).optional() });
export const identifierInputSchema = z.string().min(4).max(36).regex(/^[a-fA-F0-9-]+$/);
export const reviewCommentInputSchema = z.object({
  revisionId: identifierInputSchema.optional(), body: commentSchema.shape.body,
  commit: z.string().min(1).max(256).optional(),
  replyTo: identifierInputSchema.nullable().default(null),
});
export type Review = z.infer<typeof reviewSchema>;
export const trackingStateSchema = z.object({
  branch: trackedBranchSchema, head: commitId, observed: commitId.optional(),
  awaitingPush: z.boolean().optional(),
  remote: z.string().min(1).max(256).optional(),
  state: z.enum(['waiting', 'following', 'missing', 'awaiting-push']),
}).strict();
export type TrackingState = z.infer<typeof trackingStateSchema>;
export interface ReviewView extends Review {
  currentRevisionId: string;
  trackingStatus?: TrackingState;
}
export type ReviewComment = z.infer<typeof reviewCommentSchema>;
export const commentMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), body: commentSchema.shape.body, expectedVersion: z.uuid() }),
  z.object({ kind: z.literal('delete'), expectedVersion: z.uuid() }),
  z.object({ kind: z.literal('resolve'), expectedVersion: z.uuid(), expectedThread: threadVersionSchema }),
  z.object({ kind: z.literal('reopen'), expectedVersion: z.uuid(), expectedThread: threadVersionSchema }),
]);
export const reviewMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), title: z.string().trim().min(1).max(256), expectedVersion: z.uuid() }),
  z.object({ kind: z.literal('delete'), expectedVersion: z.uuid() }),
]);
export type CommentMutation = z.infer<typeof commentMutationSchema>;
export type ReviewMutation = z.infer<typeof reviewMutationSchema>;

export interface RevisionDiff {
  reviewId: string;
  revisionId: string;
  base: string;
  head: string;
  patch: string;
}

export interface BranchChoice {
  ref: string;
  name: string;
  commit: string;
  remote: boolean;
  current: boolean;
}

export const commitListInputSchema = z.object({
  ref: z.string().min(1).max(256).default('HEAD'),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface CommitPage {
  tip: string;
  commits: { commit: string; subject: string; author: string; authoredAt: string; noteCount: number | null }[];
  nextOffset: number | null;
}

export const noteCountsInputSchema = z.object({ commits: z.array(commitId).max(100) });
export type NoteCounts = Record<string, number | null>;

export const syncInputSchema = z.object({ remote: z.string().min(1).max(256).optional() });
export interface SyncResult {
  remote: string;
  downloaded: number;
  merged: number;
  uploaded: number;
  unchanged: number;
}

export interface ReceiveResult {
  remote: string;
  updatedRefs: string[];
  updatedReviewIds?: string[];
  updatedNoteCommits?: string[];
}

export const backgroundUpdatesInputSchema = z.object({
  enabled: z.boolean(), remote: z.string().min(1).max(256),
});

export interface BackgroundUpdateStatus {
  enabled: boolean;
  remote: string | null;
  running: boolean;
  paused: boolean;
  intervalSeconds: number;
  revision: number;
  latestChangeSummary: {
    remote: string;
    notesUpdated: boolean;
    reviewsUpdated: number;
    sampleReviewIds: string[];
    sampleNoteCommits: string[];
  } | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
}
