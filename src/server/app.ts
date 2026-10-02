import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Reviews } from '../core/reviews.js';
import { Synchronization } from '../core/sync.js';
import { BackgroundUpdates } from './background-updates.js';
import { backgroundUpdatesInputSchema, followReviewSchema } from '../core/models.js';
import { commentMutationSchema, reviewMutationSchema, noteCountsInputSchema } from '../core/models.js';
import { addCommentSchema, createReviewSchema, revisionInputSchema, reviewCommentInputSchema, identifierInputSchema, commitListInputSchema, syncInputSchema } from '../core/models.js';

export async function createServer(reviews: Reviews, initialCommit = 'HEAD', options: { backgroundIntervalMs?: number } = {}) {
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  const token = randomBytes(32).toString('hex');
  const synchronization = new Synchronization(reviews.repository);
  const defaultRemote = await reviews.repository.discussRemote();
  const background = new BackgroundUpdates(synchronization, options.backgroundIntervalMs, defaultRemote);
  if (await reviews.repository.discussUpdatesEnabled()) {
    await background.configure({ enabled: true, remote: defaultRemote }, false);
  }
  app.addHook('onClose', async () => { await background.close(); });

  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const host = `127.0.0.1:${port}`;
    if (request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      return reply.code(403).send({ error: 'Untrusted request origin.' });
    }
    if (request.url.split('?')[0].startsWith('/api/') &&
        request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: 'Open the full URL printed by git discuss serve.' });
    }
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });

  app.setErrorHandler((error, _request, reply) => {
    reply.code(400).send({ error: error instanceof Error ? error.message : 'Request failed.' });
  });

  app.get('/api/repository', async () => ({
    root: reviews.repository.root, initialCommit,
    currentBranch: await reviews.repository.git('branch', '--show-current') || null,
  }));
  app.get('/api/remotes', async () => reviews.repository.remotes());
  app.post('/api/settings/remote', async request => {
    const { remote } = z.object({ remote: z.string().min(1).max(256) }).parse(request.body);
    if (remote.startsWith('-') || !(await reviews.repository.remotes()).includes(remote)) {
      throw new Error('Choose a configured Git remote.');
    }
    await reviews.repository.setDiscussRemote(remote);
    return { remote };
  });
  app.post('/api/sync', async request => {
    const input = syncInputSchema.parse(request.body);
    return background.withForeground(() => synchronization.sync(input));
  });
  app.post('/api/receive', async request => background.receiveNow(syncInputSchema.parse(request.body)));
  app.get('/api/background-updates', async () => background.status());
  app.post('/api/background-updates', async request => background.configure(backgroundUpdatesInputSchema.parse(request.body)));
  app.post('/api/background-updates/check', async () => background.checkNow());
  app.get('/api/branches', async () => reviews.repository.branches());
  app.post('/api/branches/switch', async request => {
    const { branch } = z.object({ branch: z.string().min(1).max(256) }).strict().parse(request.body);
    await reviews.repository.switchBranch(branch);
    return { currentBranch: await reviews.repository.git('branch', '--show-current') || null };
  });
  app.get('/api/commits', async request => reviews.repository.commits(commitListInputSchema.parse(request.query)));
  app.post('/api/note-counts', async request => reviews.repository.noteCounts(noteCountsInputSchema.parse(request.body).commits));
  const reviewId = (params: unknown) => z.object({ id: identifierInputSchema }).parse(params).id;
  app.get('/api/reviews', async () => Promise.all((await reviews.listReviews()).map(review => reviews.view(review))));
  app.post('/api/reviews', async (request, reply) => {
    const input = createReviewSchema.parse(request.body);
    return reply.code(201).send(await reviews.view(await background.withForeground(() => reviews.createReview(input))));
  });
  app.get('/api/reviews/:id', async request => reviews.view(await reviews.review(reviewId(request.params))));
  app.post('/api/reviews/:id/tracking', async request => {
    const id = reviewId(request.params); const input = followReviewSchema.parse(request.body);
    return reviews.view(await background.withForeground(() => reviews.followBranch(id, input)));
  });
  app.post('/api/reviews/:id/change', async request => {
    const id = reviewId(request.params); const input = reviewMutationSchema.parse(request.body);
    return reviews.view(await background.withForeground(() => reviews.changeReview(id, input)));
  });
  app.post('/api/reviews/:id/comments/:commentId/change', async request => {
    const { id, commentId } = z.object({ id: identifierInputSchema, commentId: identifierInputSchema }).parse(request.params);
    const input = commentMutationSchema.parse(request.body);
    return reviews.view(await background.withForeground(() => reviews.changeReviewComment(id, commentId, input)));
  });
  app.post('/api/commits/:commit/comments/:commentId/change', async request => {
    const { commit, commentId } = z.object({ commit: z.string().min(1).max(256), commentId: identifierInputSchema }).parse(request.params);
    const input = commentMutationSchema.parse(request.body);
    return background.withForeground(() => reviews.changeCommitComment(commit, commentId, input));
  });
  app.get('/api/reviews/:id/revisions/:revisionId/diff', async request => {
    const params = z.object({ id: identifierInputSchema, revisionId: identifierInputSchema }).parse(request.params);
    return reviews.revisionDiff(params.id, params.revisionId);
  });
  app.post('/api/reviews/:id/revisions', async (request, reply) => {
    const id = reviewId(request.params); const input = revisionInputSchema.parse(request.body);
    return reply.code(201).send(await reviews.view(await background.withForeground(() => reviews.addRevision(id, input))));
  });
  app.post('/api/reviews/:id/comments', async (request, reply) => {
    const id = reviewId(request.params); const input = reviewCommentInputSchema.parse(request.body);
    return reply.code(201).send(await background.withForeground(() => reviews.addReviewComment(id, input)));
  });
  app.get('/api/conversation', async request => {
    const { commit } = z.object({ commit: z.string().min(1).max(256) }).parse(request.query);
    return reviews.conversation(commit);
  });
  app.post('/api/comments', async (request, reply) => {
    const input = addCommentSchema.parse(request.body);
    const comment = await background.withForeground(() => reviews.addComment(input));
    return reply.code(201).send(comment);
  });
  await app.register(staticFiles, { root: fileURLToPath(new URL('../web/', import.meta.url)) });
  return { app, token };
}
