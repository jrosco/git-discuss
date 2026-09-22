import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Reviews } from '../core/reviews.js';
import { Synchronization } from '../core/sync.js';
import { commentMutationSchema, reviewMutationSchema, noteCountsInputSchema } from '../core/models.js';
import { addCommentSchema, createReviewSchema, revisionInputSchema, reviewCommentInputSchema, identifierInputSchema, commitListInputSchema, syncInputSchema } from '../core/models.js';

export async function createServer(reviews: Reviews, initialCommit = 'HEAD') {
  const app = Fastify({ bodyLimit: 128 * 1024 });
  const token = randomBytes(32).toString('hex');

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
  app.post('/api/sync', async request => new Synchronization(reviews.repository).sync(syncInputSchema.parse(request.body)));
  app.get('/api/branches', async () => reviews.repository.branches());
  app.get('/api/commits', async request => reviews.repository.commits(commitListInputSchema.parse(request.query)));
  app.post('/api/note-counts', async request => reviews.repository.noteCounts(noteCountsInputSchema.parse(request.body).commits));
  const reviewId = (params: unknown) => z.object({ id: identifierInputSchema }).parse(params).id;
  app.get('/api/reviews', async () => reviews.listReviews());
  app.post('/api/reviews', async (request, reply) => {
    return reply.code(201).send(await reviews.createReview(createReviewSchema.parse(request.body)));
  });
  app.get('/api/reviews/:id', async request => reviews.review(reviewId(request.params)));
  app.post('/api/reviews/:id/change', async request => reviews.changeReview(reviewId(request.params), reviewMutationSchema.parse(request.body)));
  app.post('/api/reviews/:id/comments/:commentId/change', async request => {
    const { id, commentId } = z.object({ id: identifierInputSchema, commentId: identifierInputSchema }).parse(request.params);
    return reviews.changeReviewComment(id, commentId, commentMutationSchema.parse(request.body));
  });
  app.post('/api/commits/:commit/comments/:commentId/change', async request => {
    const { commit, commentId } = z.object({ commit: z.string().min(1).max(256), commentId: identifierInputSchema }).parse(request.params);
    return reviews.changeCommitComment(commit, commentId, commentMutationSchema.parse(request.body));
  });
  app.get('/api/reviews/:id/revisions/:revisionId/diff', async request => {
    const params = z.object({ id: identifierInputSchema, revisionId: identifierInputSchema }).parse(request.params);
    return reviews.revisionDiff(params.id, params.revisionId);
  });
  app.post('/api/reviews/:id/revisions', async (request, reply) => {
    return reply.code(201).send(await reviews.addRevision(reviewId(request.params), revisionInputSchema.parse(request.body)));
  });
  app.post('/api/reviews/:id/comments', async (request, reply) => {
    return reply.code(201).send(await reviews.addReviewComment(reviewId(request.params), reviewCommentInputSchema.parse(request.body)));
  });
  app.get('/api/conversation', async request => {
    const { commit } = z.object({ commit: z.string().min(1).max(256) }).parse(request.query);
    return reviews.conversation(commit);
  });
  app.post('/api/comments', async (request, reply) => {
    const comment = await reviews.addComment(addCommentSchema.parse(request.body));
    return reply.code(201).send(comment);
  });
  await app.register(staticFiles, { root: fileURLToPath(new URL('../web/', import.meta.url)) });
  return { app, token };
}
