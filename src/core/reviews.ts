import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Repository } from '../git/repository.js';
import { addCommentSchema, commentSchema, type AddComment, type Comment, type Conversation } from './models.js';
import { createReviewSchema, revisionInputSchema, reviewCommentInputSchema, reviewSchema, type Review, type RevisionDiff } from './models.js';
import { resolveIdentifier } from './identifiers.js';

export class Reviews {
  constructor(readonly repository: Repository) {}

  private reviewRef(id: string): string {
    return `refs/git-discuss/reviews/${z.uuid().parse(id)}`;
  }

  private async readReview(id: string) {
    const refs = await this.repository.reviewRefs();
    id = resolveIdentifier(id, refs.map(entry => entry.ref.slice('refs/git-discuss/reviews/'.length)), 'Review');
    const ref = this.reviewRef(id);
    const entry = refs.find(entry => entry.ref === ref);
    if (!entry) throw new Error(`Review "${id}" does not exist.`);
    const review = reviewSchema.parse(JSON.parse(await this.repository.readReviewSnapshot(entry.oid)));
    if (review.id !== id) throw new Error('Review ID does not match its ref.');
    return { review, oid: entry.oid };
  }

  async review(id: string): Promise<Review> {
    return (await this.readReview(id)).review;
  }

  async listReviews(): Promise<Review[]> {
    const refs = await this.repository.reviewRefs();
    return Promise.all(refs.map(entry => this.review(entry.ref.slice('refs/git-discuss/reviews/'.length))));
  }

  async deleteReview(id: string): Promise<Review> {
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      await this.repository.git('update-ref', '-d', this.reviewRef(review.id), oid);
      return review;
    });
  }

  async revisionDiff(id: string, revisionId: string): Promise<RevisionDiff> {
    const review = await this.review(id);
    const resolved = resolveIdentifier(revisionId, review.revisions.map(item => item.id), 'Revision');
    const revision = review.revisions.find(item => item.id === resolved)!;
    return { reviewId: review.id, revisionId: resolved, base: revision.base, head: revision.head,
      patch: await this.repository.diff(revision.base, revision.head) };
  }

  private async author() {
    return {
      name: await this.repository.git('config', '--get', 'user.name'),
      email: await this.repository.git('config', '--get', 'user.email'),
    };
  }

  private async revision(input: z.input<typeof revisionInputSchema>) {
    const parsed = revisionInputSchema.parse(input);
    return {
      id: randomUUID(), base: await this.repository.resolve(parsed.base),
      head: await this.repository.resolve(parsed.head),
      author: await this.author(), createdAt: new Date().toISOString(),
    };
  }

  async createReview(input: z.input<typeof createReviewSchema>): Promise<Review> {
    const parsed = createReviewSchema.parse(input);
    return this.repository.withWriteLock(async () => {
      const revision = await this.revision(parsed);
      const review = reviewSchema.parse({
        schema: 1, type: 'review', id: randomUUID(), title: parsed.title,
        author: revision.author, createdAt: revision.createdAt, revisions: [revision], comments: [],
      });
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), undefined,
        JSON.stringify(review), [revision.base, revision.head]);
      return review;
    });
  }

  async addRevision(id: string, input: z.input<typeof revisionInputSchema>): Promise<Review> {
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      const revision = await this.revision(input);
      const latest = review.revisions[review.revisions.length - 1];
      if (latest.base === revision.base && latest.head === revision.head) {
        throw new Error('The latest revision already has this base and head.');
      }
      review.revisions.push(revision);
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), oid,
        JSON.stringify(reviewSchema.parse(review)), [revision.base, revision.head]);
      return review;
    });
  }

  async addReviewComment(id: string, input: z.input<typeof reviewCommentInputSchema>) {
    const parsed = reviewCommentInputSchema.parse(input);
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      const revisionId = parsed.revisionId === undefined ? review.revisions[review.revisions.length - 1].id :
        resolveIdentifier(parsed.revisionId, review.revisions.map(item => item.id), 'Revision');
      const revision = review.revisions.find(item => item.id === revisionId)!;
      const replyTo = parsed.replyTo ? resolveIdentifier(parsed.replyTo, review.comments.map(item => item.id), 'Reply target') : null;
      const comment = {
        ...parsed, revisionId, replyTo, schema: 1 as const, type: 'comment' as const, id: randomUUID(), commit: revision.head,
        author: await this.author(), createdAt: new Date().toISOString(),
      };
      review.comments.push(comment);
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), oid,
        JSON.stringify(reviewSchema.parse(review)), []);
      return comment;
    });
  }

  private async comments(commit: string): Promise<Comment[]> {
    const note = await this.repository.readNote(commit);
    if (!note) return [];
    const comments = z.array(commentSchema).parse(JSON.parse(note));
    const seen = new Set<string>();
    for (const item of comments) {
      if (item.commit !== commit || seen.has(item.id) || (item.replyTo && !seen.has(item.replyTo))) {
        throw new Error('Invalid discussion history: commit, comment ID, or reply relationship.');
      }
      seen.add(item.id);
    }
    return comments;
  }

  async conversation(ref: string): Promise<Conversation> {
    const commit = await this.repository.resolve(ref);
    return {
      commit,
      subject: await this.repository.git('show', '-s', '--format=%s', commit, '--'),
      comments: await this.comments(commit),
    };
  }

  async addComment(input: AddComment): Promise<Comment> {
    const parsed = addCommentSchema.parse(input);
    const commit = await this.repository.resolve(parsed.commit);
    return this.repository.withWriteLock(async () => {
      const comments = await this.comments(commit);
      if (parsed.replyTo && !comments.some(comment => comment.id === parsed.replyTo)) {
        throw new Error('Reply target does not exist on this commit.');
      }
      const name = await this.repository.git('config', '--get', 'user.name');
      const email = await this.repository.git('config', '--get', 'user.email');
      const comment = commentSchema.parse({
        schema: 1, type: 'comment', id: randomUUID(), commit,
        author: { name, email }, createdAt: new Date().toISOString(),
        replyTo: parsed.replyTo, body: parsed.body,
      });
      await this.repository.writeNote(commit, JSON.stringify([...comments, comment], null, 2));
      return comment;
    });
  }
}
