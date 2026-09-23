import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Repository } from '../git/repository.js';
import { addCommentSchema, commentSchema, type AddComment, type Comment, type Conversation, type SavedCommitNote } from './models.js';
import { createReviewSchema, revisionInputSchema, reviewCommentInputSchema, reviewSchema, type Review, type RevisionDiff } from './models.js';
import { resolveIdentifier } from './identifiers.js';
import { commentChangeSchema, commentMutationSchema, reviewMutationSchema, type CommentMutation, type ReviewMutation } from './models.js';
import { isDeleted, isThreadResolved, recordVersion, threadRoot, threadVersion, MAX_COMMIT_NOTE_LENGTH } from './changes.js';
import { BranchTracking } from './tracking.js';
import { followReviewSchema, type ReviewView } from './models.js';

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

  async view(review: Review): Promise<ReviewView> {
    return new BranchTracking(this.repository).view(review);
  }

  async followBranch(id: string, input: { head: string; trackingRemote?: string }): Promise<Review> {
    const { head, trackingRemote } = followReviewSchema.parse(input);
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      this.assertEditable(review);
      if (review.tracking) throw new Error('This review already follows a branch.');
      const tracking = new BranchTracking(this.repository);
      const { commit, branch } = await tracking.sourceFor(head);
      if (!branch) throw new Error('Choose a branch to follow, rather than an exact commit or tag.');
      const initialRemoteHead = await tracking.cachedRemoteHead(branch, head, trackingRemote);
      review.tracking = { branch, base: review.revisions[review.revisions.length - 1].base, initialHead: commit, ...(initialRemoteHead ? { initialRemoteHead } : {}) };
      review.schema = 3;
      const next = await tracking.retain(review, commit);
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), oid, JSON.stringify(reviewSchema.parse(next)), [commit, ...(initialRemoteHead ? [initialRemoteHead] : [])]);
      return next;
    });
  }

  async listReviews(): Promise<Review[]> {
    const refs = await this.repository.reviewRefs();
    return (await Promise.all(refs.map(entry => this.review(entry.ref.slice('refs/git-discuss/reviews/'.length))))).filter(review => !isDeleted(review));
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

  private assertEditable(record: { id: string; changes?: { id: string; kind: string }[] }, expectedVersion?: string, allowDeleted = false) {
    if (!allowDeleted && isDeleted(record)) throw new Error('This item was deleted. Refresh to see the latest discussion.');
    if (expectedVersion !== undefined && recordVersion(record) !== expectedVersion) {
      throw new Error('This item changed since you opened it. Refresh before editing or deleting; your draft has not been saved.');
    }
  }

  async changeReview(id: string, input: ReviewMutation): Promise<Review> {
    const parsed = reviewMutationSchema.parse(input);
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      this.assertEditable(review, parsed.expectedVersion);
      const { expectedVersion: _expected, ...action } = parsed;
      review.schema = Math.max(review.schema, 2) as Review['schema'];
      review.changes = [...(review.changes ?? []), { ...action, id: randomUUID(), author: await this.author(), createdAt: new Date().toISOString() }];
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), oid, JSON.stringify(reviewSchema.parse(review)), []);
      return review;
    });
  }

  private async changeCommentRecord<T extends Comment>(comment: T, input: CommentMutation): Promise<T> {
    const statusChange = input.kind === 'resolve' || input.kind === 'reopen';
    this.assertEditable(comment, input.expectedVersion, statusChange);
    const action = input.kind === 'resolve' ? { kind: input.kind, threadVersion: input.expectedThread }
      : input.kind === 'reopen' ? { kind: input.kind }
        : input.kind === 'edit' ? { kind: input.kind, body: input.body } : { kind: input.kind };
    return { ...comment, schema: 2, changes: [...(comment.changes ?? []), commentChangeSchema.parse({
      ...action, id: randomUUID(), author: await this.author(), createdAt: new Date().toISOString(),
    })] };
  }

  async changeReviewComment(id: string, commentId: string, input: CommentMutation): Promise<Review> {
    const parsed = commentMutationSchema.parse(input);
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      this.assertEditable(review);
      const resolved = resolveIdentifier(commentId, review.comments.map(item => item.id), 'Comment');
      const index = review.comments.findIndex(item => item.id === resolved);
      if (parsed.kind === 'resolve' || parsed.kind === 'reopen') {
        const root = review.comments[index];
        if (root.replyTo) throw new Error('Only the first comment of a thread can be resolved or reopened.');
        if (parsed.expectedThread !== threadVersion(review.comments, root.id)) {
          throw new Error('This thread changed since you opened it. Refresh the discussion before resolving or reopening it.');
        }
        const completed = isThreadResolved(root, review.comments);
        if (parsed.kind === 'resolve' && completed) throw new Error('This thread is already resolved.');
        if (parsed.kind === 'reopen' && !completed) throw new Error('This thread is already open. Refresh to see any new feedback.');
      }
      review.comments[index] = await this.changeCommentRecord(review.comments[index], parsed);
      review.schema = Math.max(review.schema, 2) as Review['schema'];
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), oid, JSON.stringify(reviewSchema.parse(review)), []);
      return review;
    });
  }

  async changeCommitComment(ref: string, commentId: string, input: CommentMutation): Promise<Conversation> {
    void ref; void commentId; void input;
    throw new Error('Commit notes are plain text and no longer support per-comment edit endpoints. Use Save note on the commit instead.');
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
      const source = parsed.followBranch ? await new BranchTracking(this.repository).sourceFor(parsed.head) : null;
      const revision = await this.revision({ base: parsed.base, head: source?.commit ?? parsed.head });
      const branch = source?.branch ?? null;
      const initialRemoteHead = branch ? await new BranchTracking(this.repository).cachedRemoteHead(branch, parsed.head, parsed.trackingRemote) : undefined;
      const review = reviewSchema.parse({
        schema: branch ? 3 : 1, type: 'review', id: randomUUID(), title: parsed.title,
        author: revision.author, createdAt: revision.createdAt,
        revisions: [branch ? { ...revision, subject: await this.repository.git('show', '-s', '--no-show-signature', '--format=%s', revision.head, '--') } : revision], comments: [],
        ...(branch ? { tracking: { branch, base: revision.base, initialHead: revision.head, ...(initialRemoteHead ? { initialRemoteHead } : {}) } } : {}),
      });
      await this.repository.writeReviewSnapshot(this.reviewRef(review.id), undefined,
        JSON.stringify(review), [revision.base, revision.head, ...(initialRemoteHead ? [initialRemoteHead] : [])]);
      return review;
    });
  }

  async addRevision(id: string, input: z.input<typeof revisionInputSchema>): Promise<Review> {
    return this.repository.withWriteLock(async () => {
      const { review, oid } = await this.readReview(id);
      this.assertEditable(review);
      if (review.tracking) throw new Error('This review follows a branch. Push your code and check for updates instead of adding a manual version.');
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
      this.assertEditable(review);
      if (parsed.commit && parsed.revisionId) throw new Error('Choose either a saved commit or a comparison ID, not both.');
      let revisionId = parsed.revisionId === undefined ? (await this.view(review)).currentRevisionId :
        resolveIdentifier(parsed.revisionId, review.revisions.map(item => item.id), 'Revision');
      if (parsed.commit) {
        const commit = await this.repository.resolve(parsed.commit);
        const matches = review.revisions.filter(item => item.head === commit);
        if (!matches.length) throw new Error('This commit is not in the review. Check for code updates first.');
        if (matches.length > 1) throw new Error('This commit has multiple saved comparisons. Use --revision with a comparison ID.');
        revisionId = matches[0].id;
      }
      const revision = review.revisions.find(item => item.id === revisionId)!;
      const replyTo = parsed.replyTo ? resolveIdentifier(parsed.replyTo, review.comments.map(item => item.id), 'Reply target') : null;
      const root = replyTo ? threadRoot(review.comments, replyTo) : undefined;
      if (root && isThreadResolved(root, review.comments)) throw new Error('This thread is resolved. Reopen it before adding a reply.');
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

  async conversation(ref: string): Promise<Conversation> {
    const commit = await this.repository.resolve(ref);
    const snapshot = await this.repository.noteSnapshot(commit);
    return {
      commit,
      subject: await this.repository.git('show', '-s', '--format=%s', commit, '--'),
      commitDetails: await this.repository.commitDetails(commit),
      comments: [],
      ...snapshot,
    };
  }

  async addComment(input: AddComment): Promise<SavedCommitNote> {
    const parsed = addCommentSchema.parse(input);
    const commit = await this.repository.resolve(parsed.commit);
    return this.repository.withWriteLock(async () => {
      const name = await this.repository.git('config', '--get', 'user.name');
      const email = await this.repository.git('config', '--get', 'user.email');
      const snapshot = await this.repository.noteSnapshot(commit);
      const existing = snapshot.note;
      if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== snapshot.noteVersion) {
        throw new Error('This note changed since you opened it. Your draft has not been saved. Cancel and reload the latest note before editing or deleting.');
      }
      if (existing !== null && ['set', 'edit', 'delete'].includes(parsed.action) && parsed.expectedVersion === undefined) {
        throw new Error('Reload this note before replacing or deleting it: the current note version is required.');
      }
      const body = parsed.body;
      if (parsed.action === 'add' && existing !== null) throw new Error('A note already exists on this commit. Choose Edit or Append.');
      if (parsed.action === 'edit' && existing === null) throw new Error('No note exists on this commit yet. Choose Add note.');
      if (parsed.action === 'append' && existing === null) throw new Error('No note exists on this commit yet. Add a note before appending.');
      if (parsed.action !== 'delete' && !body.trim()) throw new Error('Note text cannot be empty.');
      const note = parsed.action === 'append' ? `${existing}\n\n${body}` : body;
      if (parsed.action !== 'delete' && note.length > MAX_COMMIT_NOTE_LENGTH) throw new Error(`A commit note cannot exceed ${MAX_COMMIT_NOTE_LENGTH.toLocaleString()} characters, including appended text.`);
      const comment = { id: randomUUID(), commit, author: commentSchema.shape.author.parse({ name, email }), createdAt: new Date().toISOString(), body };
      if (parsed.action === 'delete') await this.repository.removeNote(commit);
      else await this.repository.writeNote(commit, note);
      return { ...comment, ...await this.repository.noteSnapshot(commit) };
    });
  }
}
