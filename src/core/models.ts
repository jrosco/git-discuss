import { z } from 'zod';

export const commentSchema = z.object({
  schema: z.literal(1),
  type: z.literal('comment'),
  id: z.uuid(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  author: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  createdAt: z.iso.datetime(),
  replyTo: z.uuid().nullable(),
  body: z.string().trim().min(1).max(20000),
});

export const addCommentSchema = z.object({
  commit: z.string().min(1).max(256),
  body: commentSchema.shape.body,
  replyTo: z.uuid().nullable().default(null),
});

export type Comment = z.infer<typeof commentSchema>;
export type AddComment = z.input<typeof addCommentSchema>;
export interface Conversation {
  commit: string;
  subject: string;
  comments: Comment[];
}

const commitId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const revisionSchema = z.object({
  id: z.uuid(), base: commitId, head: commitId,
  author: commentSchema.shape.author, createdAt: z.iso.datetime(),
});
export const reviewCommentSchema = commentSchema.extend({ revisionId: z.uuid() });
export const reviewSchema = z.object({
  schema: z.literal(1), type: z.literal('review'), id: z.uuid(),
  title: z.string().trim().min(1).max(256),
  author: commentSchema.shape.author, createdAt: z.iso.datetime(),
  revisions: z.array(revisionSchema).min(1),
  comments: z.array(reviewCommentSchema),
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
  commits: { commit: string; subject: string; author: string; authoredAt: string }[];
  nextOffset: number | null;
}

export const syncInputSchema = z.object({ remote: z.string().min(1).max(256).default('origin') });
export interface SyncResult {
  remote: string;
  downloaded: number;
  merged: number;
  uploaded: number;
  unchanged: number;
}
