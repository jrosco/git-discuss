#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import open from 'open';
import { access, readFile } from 'node:fs/promises';
import { Repository } from './git/repository.js';
import { Reviews } from './core/reviews.js';
import { createServer } from './server/app.js';
import { shortIdentifier } from './core/identifiers.js';
import { Synchronization } from './core/sync.js';
import { reviewTitle } from './core/changes.js';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const program = new Command()
  .name('git discuss')
  .description('Local-first Git-backed commit discussions')
  .version(version)
  .option('--repo <path>', 'Git working tree', process.cwd());

async function reviews() {
  return new Reviews(await Repository.open(program.opts().repo));
}

program.command('show')
  .option('--commit <ref>', 'Commit to inspect', 'HEAD')
  .action(async options => {
    console.log(JSON.stringify(await (await reviews()).conversation(options.commit), null, 2));
  });

program.command('comment <message>')
  .option('--commit <ref>', 'Commit to comment on', 'HEAD')
  .option('--append', 'Append to an existing commit note instead of creating a new note')
  .action(async (body, options) => {
    const comment = await (await reviews()).addComment({ commit: options.commit, body, action: options.append ? 'append' : 'add' });
    console.log(`Saved locally: ${comment.id}`);
  });

const review = program.command('review').description('Branch-following reviews with retained commit discussions');
review.command('list').option('--json', 'Print complete reviews as JSON').action(async options => {
  const engine = await reviews();
  const items = await Promise.all((await engine.listReviews()).map(item => engine.view(item)));
  if (options.json) { console.log(JSON.stringify(items, null, 2)); return; }
  if (!items.length) { console.log('No reviews yet. Create one with: git discuss review create "Title" --base <branch>'); return; }
  const ids = items.map(item => item.id);
  const rows = items.map(item => [
    shortIdentifier(item.id, ids),
    item.revisions.find(revision => revision.id === item.currentRevisionId)!.head.slice(0, 12),
    String(new Set(item.revisions.map(revision => revision.head)).size), String(item.comments.length), reviewTitle(item).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '),
  ]);
  rows.unshift(['REVIEW', 'CURRENT COMMIT', 'COMMITS', 'COMMENTS', 'TITLE']);
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  console.log(rows.map(row => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join('  ')).join('\n'));
});
review.command('create <title>')
  .requiredOption('--base <ref>', 'Base commit')
  .option('--head <ref>', 'Head commit', 'HEAD')
  .option('--pinned', 'Keep a fixed comparison instead of following the head branch')
  .action(async (title, options) => {
    const engine = await reviews();
    console.log(JSON.stringify(await engine.view(await engine.createReview({ title, base: options.base, head: options.head, followBranch: !options.pinned })), null, 2));
  });
review.command('show <id>').action(async id => {
  const engine = await reviews();
  console.log(JSON.stringify(await engine.view(await engine.review(id)), null, 2));
});
review.command('follow <id>').requiredOption('--head <branch>', 'Branch to follow for an existing pinned review')
  .action(async (id, options) => {
    const engine = await reviews();
    console.log(JSON.stringify(await engine.view(await engine.followBranch(id, { head: options.head })), null, 2));
  });
review.command('revise <id>')
  .requiredOption('--base <ref>', 'Base commit')
  .option('--head <ref>', 'Head commit', 'HEAD')
  .action(async (id, options) => {
    console.log(JSON.stringify(await (await reviews()).addRevision(id, options), null, 2));
  });
review.command('comment <id> <message>')
  .option('--commit <ref>', 'Saved commit to discuss (defaults to the review’s current code)')
  .option('--revision <id>', 'Advanced: saved comparison ID or prefix', (value: string, previous: string | undefined) => {
    if (previous !== undefined) throw new InvalidArgumentError('Use --revision only once. Usage: git discuss review comment <review-id> "message" [--revision <revision-id>]');
    return value;
  })
  .option('--reply-to <id>', 'Parent comment ID within this review')
  .action(async (id, body, options) => {
    const comment = await (await reviews()).addReviewComment(id, {
      body, revisionId: options.revision, commit: options.commit, replyTo: options.replyTo,
    });
    console.log(`Saved locally: ${comment.id}\nRevision: ${comment.revisionId}\nHead: ${comment.commit}`);
  });

review.command('delete <id>').description('Delete a local review and its retained revision ref')
  .action(async id => {
    const deleted = await (await reviews()).deleteReview(id);
    console.log(`Deleted local review: ${deleted.id}`);
  });

program.command('sync').description('Fetch, reconcile, and push commit notes and reviews')
  .option('--remote <name>', 'Configured Git remote (defaults to git-discuss.remote, then origin)')
  .option('--json', 'Print sync counts as JSON')
  .action(async options => {
    const engine = await reviews();
    const result = await new Synchronization(engine.repository).sync({ remote: options.remote });
    console.log(options.json ? JSON.stringify(result, null, 2) :
      `Synced discussions with ${result.remote}.\nRefs: ${result.downloaded} downloaded, ${result.merged} reconciled, ${result.uploaded} uploaded, ${result.unchanged} unchanged.`);
  });

program.command('serve')
  .option('--commit <ref>', 'Initial commit', 'HEAD')
  .option('--port <number>', 'Local port (0 selects an available port)', '0')
  .option('--no-open', 'Do not open the browser')
  .action(async options => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
    const engine = await reviews();
    await engine.conversation(options.commit);
    try {
      await access(new URL('./web/index.html', import.meta.url));
    } catch {
      throw new Error('Build the application with npm run build, then run node dist/cli.js serve.');
    }
    const { app, token } = await createServer(engine, options.commit);
    const address = await app.listen({ host: '127.0.0.1', port });
    const url = `${address}/#token=${token}`;
    console.log(`Git Discuss: ${url}\nRepository: ${engine.repository.root}\nComments are saved locally. Use Sync to share them. Press Ctrl+C to stop.`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { void app.close(); });
    }
    if (options.open) {
      try { await open(url); } catch { console.error('Could not open a browser. Open the URL above manually.'); }
    }
  });

program.parseAsync().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
