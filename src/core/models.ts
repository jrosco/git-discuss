import { z } from 'zod';

const changeMetadata = {
  id: z.uuid(), author: z.object({ name: z.string().min(1), email: z.string().min(1) }), createdAt: z.iso.datetime(),
};
export const commentChangeSchema = z.discriminatedUnion('kind', [
  z.object({ ...changeMetadata, kind: z.literal('edit'), body: z.string().trim().min(1).max(20000) }),
  z.object({ ...changeMetadata, kind: z.literal('delete') }),
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
  body: z.string().max(20000).default(''),
  action: z.enum(['set', 'add', 'edit', 'append', 'delete']).default('set'),
}).strict();

export type Comment = z.infer<typeof commentSchema>;
export type AddComment = z.input<typeof addCommentSchema>;
export interface Conversation {
  commit: string;
  subject: string;
  comments: Comment[];
  note: string | null;
}

export const commitNoteInputSchema = z.object({
  commit: z.string().min(1).max(256),
  note: z.string().max(20000).nullable(),
});

const commitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const revisionSchema = z.object({
  id: z.uuid(), base: commitId, head: commitId,
  author: commentSchema.shape.author, createdAt: z.iso.datetime(),
});
export const reviewCommentSchema = commentSchema.extend({ revisionId: z.uuid() });
export const reviewSchema = z.object({
  schema: z.union([z.literal(1), z.literal(2)]), type: z.literal('review'), id: z.uuid(),
  title: z.string().trim().min(1).max(256),
  author: commentSchema.shape.author, createdAt: z.iso.datetime(),
  revisions: z.array(revisionSchema).min(1),
  comments: z.array(reviewCommentSchema),
  changes: z.array(reviewChangeSchema).min(1).refine(uniqueChanges, 'Duplicate change ID.').optional(),
}).superRefine((review, context) => {
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
    comments.add(comment.id);
  }
});
export const revisionInputSchema = z.object({
  base: z.string().min(1).max(256), head: z.string().min(1).max(256),
});
export const createReviewSchema = revisionInputSchema.extend({ title: z.string().trim().min(1).max(256) });
export const identifierInputSchema = z.string().min(4).max(36).regex(/^[a-fA-F0-9-]+$/);
export const reviewCommentInputSchema = z.object({
  revisionId: identifierInputSchema.optional(), body: commentSchema.shape.body,
  replyTo: identifierInputSchema.nullable().default(null),
});
export type Review = z.infer<typeof reviewSchema>;
export type ReviewComment = z.infer<typeof reviewCommentSchema>;
export const commentMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), body: commentSchema.shape.body, expectedVersion: z.uuid() }),
  z.object({ kind: z.literal('delete'), expectedVersion: z.uuid() }),
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

export const syncInputSchema = z.object({ remote: z.string().min(1).max(256).default('origin') });
export interface SyncResult {
  remote: string;
  downloaded: number;
  merged: number;
  uploaded: number;
  unchanged: number;
  noteOverwriteCommits?: string[];
}

export interface ReceiveResult {
  remote: string;
  updatedRefs: string[];
  updatedReviewIds?: string[];
  updatedNoteCommits?: string[];
  noteOverwriteCommits?: string[];
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
    notesUpdated: boolean;
    reviewsUpdated: number;
    sampleReviewIds: string[];
    sampleNoteCommits: string[];
    noteOverwriteCommits: string[];
  } | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
}
