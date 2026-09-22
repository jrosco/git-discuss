import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NOTES_REF, Repository } from '../git/repository.js';
import { syncInputSchema, type Comment, type Review, type SyncResult, type ReceiveResult } from './models.js';
import { canonical, mergeComments, mergeReviews, parseComments, parseReview } from './reconciliation.js';

const REVIEWS = 'refs/git-discuss/reviews/';
type RefMap = Map<string, string>;

export class Synchronization {
  constructor(readonly repository: Repository) {}

  private async refs(...prefixes: string[]): Promise<RefMap> {
    const output = await this.repository.git('for-each-ref', '--format=%(refname) %(objectname) %(symref)', ...prefixes);
    return new Map(output ? output.split('\n').map(line => {
      const [ref, oid, symbolic] = line.split(' ');
      if (symbolic) throw new Error(`Symbolic discussion ref ${ref} is not supported by sync.`);
      return [ref, oid];
    }) : []);
  }

  private validateRef(ref: string) {
    if (ref !== NOTES_REF) z.uuid().parse(ref.slice(REVIEWS.length));
  }

  private async readNotes(oid?: string, signal?: AbortSignal): Promise<Map<string, Comment[]>> {
    const notes = new Map<string, Comment[]>();
    if (!oid) return notes;
    const tree = await this.repository.git('ls-tree', '-r', '--full-tree', oid);
    for (const line of tree ? tree.split('\n') : []) {
      signal?.throwIfAborted();
      const match = /^100644 blob ([a-f0-9]+)\t([a-f0-9/]+)$/.exec(line);
      const commit = match?.[2].replaceAll('/', '');
      if (!match || !commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || notes.has(commit)) {
        throw new Error('Unsupported Git Discuss notes tree. Sync stopped without dropping any files.');
      }
      notes.set(commit, parseComments(await this.repository.git('cat-file', 'blob', match[1]), commit));
    }
    return notes;
  }

  private async snapshot(files: Map<string, string>, parents: string[], signal?: AbortSignal): Promise<string> {
    const entries: string[] = [];
    for (const [name, contents] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      signal?.throwIfAborted();
      const blob = await this.repository.gitInput(contents, 'hash-object', '-w', '--stdin');
      entries.push(`100644 blob ${blob}\t${name}\n`);
    }
    const tree = await this.repository.gitInput(entries.join(''), 'mktree');
    return this.repository.gitInput('Git Discuss sync\n', '-c', 'commit.gpgsign=false', 'commit-tree', tree,
      ...[...new Set(parents)].flatMap(parent => ['-p', parent]));
  }

  private async reconcile(ref: string, local?: string, remote?: string, signal?: AbortSignal): Promise<string> {
    const parents = [local, remote].filter((oid): oid is string => Boolean(oid));
    const files = new Map<string, string>();
    const retained = new Set<string>();
    let sameLocal = false;
    let sameRemote = false;
    if (ref === NOTES_REF) {
      const left = await this.readNotes(local, signal);
      const right = await this.readNotes(remote, signal);
      for (const commit of new Set([...left.keys(), ...right.keys()])) {
        files.set(commit, canonical(mergeComments(left.get(commit) ?? [], right.get(commit) ?? [])));
        retained.add(commit);
      }
      const same = (notes: Map<string, Comment[]>) => notes.size === files.size &&
        [...notes].every(([commit, comments]) => files.get(commit) === canonical(comments));
      sameLocal = same(left); sameRemote = same(right);
    } else {
      const id = ref.slice(REVIEWS.length);
      const read = async (oid?: string) => oid ? parseReview(await this.repository.readReviewSnapshot(oid), id) : undefined;
      const left = await read(local);
      const right = await read(remote);
      const review: Review = left && right ? mergeReviews(left, right) : (left ?? right)!;
      const contents = canonical(review);
      files.set('review.json', contents);
      sameLocal = Boolean(left && canonical(left) === contents);
      sameRemote = Boolean(right && canonical(right) === contents);
      for (const revision of review.revisions) { retained.add(revision.base); retained.add(revision.head); }
    }
    // Legacy notes did not retain annotated code. New sync snapshots do, so another clone can read it.
    for (const commit of retained) {
      signal?.throwIfAborted();
      try { await this.repository.resolve(commit); }
      catch { throw new Error(`Discussion references unavailable code ${commit}. Fetch its code branch, then retry sync.`); }
    }
    const reusable = async (candidate: string | undefined, same: boolean, other?: string) => {
      if (!candidate || !same || (other && !await this.repository.isAncestor(other, candidate))) return false;
      for (const commit of retained) {
        signal?.throwIfAborted();
        if (!await this.repository.isAncestor(commit, candidate)) return false;
      }
      return true;
    };
    if (await reusable(local, sameLocal, remote)) return local!;
    if (await reusable(remote, sameRemote, local)) return remote!;
    // Avoid redundant code parents when existing snapshot histories already retain them.
    for (const commit of retained) {
      signal?.throwIfAborted();
      let reachable = false;
      for (const parent of parents) if (await this.repository.isAncestor(commit, parent)) { reachable = true; break; }
      if (!reachable) parents.push(commit);
    }
    return this.snapshot(files, parents, signal);
  }

  async receive(input: { remote?: string } = {}, signal?: AbortSignal): Promise<ReceiveResult> {
    const { remote } = syncInputSchema.parse(input);
    signal?.throwIfAborted();
    if (remote.startsWith('-') || !(await this.repository.remotes()).includes(remote)) {
      throw new Error(`Remote "${remote}" is not configured. Refresh connections and choose a configured remote.`);
    }
    const staging = `refs/git-discuss/background/${randomUUID()}/`;
    try {
      const advertised = await this.repository.networkWithSignal(signal, 'ls-remote', '--refs', remote, NOTES_REF, `${REVIEWS}*`);
      const names = advertised ? advertised.split('\n').map(line => line.split('\t')[1]) : [];
      for (const ref of names) this.validateRef(ref);
      const specs: string[] = [];
      if (names.includes(NOTES_REF)) specs.push(`${NOTES_REF}:${staging}notes`);
      if (names.some(ref => ref.startsWith(REVIEWS))) specs.push(`${REVIEWS}*:${staging}reviews/*`);
      if (!specs.length) return { remote, updatedRefs: [] };
      await this.repository.networkWithSignal(signal, 'fetch', '--atomic', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, ...specs);
      signal?.throwIfAborted();
      const fetched = await this.refs(staging);
      const local = await this.refs(NOTES_REF, REVIEWS);
      const targets = new Map<string, string>();
      const checked = new Map<string, string | undefined>();
      // Prepare outside the application lock. A foreground writer can save throughout network/merge work.
      for (const [temporaryRef, right] of fetched) {
        signal?.throwIfAborted();
        const ref = temporaryRef === `${staging}notes` ? NOTES_REF : `${REVIEWS}${temporaryRef.slice(`${staging}reviews/`.length)}`;
        this.validateRef(ref);
        const left = local.get(ref);
        checked.set(ref, left);
        // Different tips must still be validated, even when one is an ancestor: an external
        // writer may have changed an immutable record rather than appending a supported edit.
        if (left === right) continue;
        const next = await this.reconcile(ref, left, right, signal);
        if (next !== left) targets.set(ref, next);
      }
      signal?.throwIfAborted();
      if (!targets.size) return { remote, updatedRefs: [] };
      await this.repository.withWriteLock(async () => {
        signal?.throwIfAborted();
        const commands = [...checked].map(([ref, previous]) => {
          const next = targets.get(ref);
          return next ? `update ${ref} ${next} ${previous ?? '0'.repeat(next.length)}` : `verify ${ref} ${previous}`;
        });
        // If any local input changed while preparing, the whole transaction fails. The next check retries.
        await this.repository.gitInput(`start\noption no-deref\n${commands.join('\n')}\nprepare\ncommit\n`, 'update-ref', '--stdin');
      });
      return { remote, updatedRefs: [...targets.keys()] };
    } finally {
      const staged = await this.refs(staging);
      if (staged.size) await this.repository.gitInput(
        [...staged].map(([ref, oid]) => `delete ${ref} ${oid}\n`).join(''), 'update-ref', '--stdin');
    }
  }

  async sync(input: { remote?: string } = {}): Promise<SyncResult> {
    const { remote } = syncInputSchema.parse(input);
    if (remote.startsWith('-') || !(await this.repository.remotes()).includes(remote)) {
      throw new Error(`Remote "${remote}" is not configured. Add it with git remote add, then retry.`);
    }
    // Reconcile the same repository we publish to; split fetch/push destinations need a separate remote.
    const fetchUrl = await this.repository.git('remote', 'get-url', '--all', remote);
    const pushUrl = await this.repository.git('remote', 'get-url', '--push', '--all', remote);
    if (fetchUrl.includes('\n') || pushUrl !== fetchUrl) {
      throw new Error('Sync requires one matching fetch/push URL. Configure a separate remote for the shared discussion repository.');
    }
    return this.repository.withWriteLock(async () => {
      const staging = `refs/git-discuss/sync/${randomUUID()}/`;
      let published = false;
      try {
        const local = new Map([...(await this.refs(NOTES_REF, REVIEWS))]
          .filter(([ref]) => ref === NOTES_REF || ref.startsWith(REVIEWS)));
        const advertised = await this.repository.network('ls-remote', '--refs', remote, NOTES_REF, `${REVIEWS}*`);
        const remoteNames = advertised ? advertised.split('\n').map(line => line.split('\t')[1]) : [];
        for (const ref of [...local.keys(), ...remoteNames]) this.validateRef(ref);
        const fetchSpecs: string[] = [];
        if (remoteNames.includes(NOTES_REF)) fetchSpecs.push(`${NOTES_REF}:${staging}notes`);
        if (remoteNames.some(ref => ref.startsWith(REVIEWS))) fetchSpecs.push(`${REVIEWS}*:${staging}reviews/*`);
        if (fetchSpecs.length) {
          await this.repository.network('fetch', '--atomic', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, ...fetchSpecs);
        }
        const fetched = await this.refs(staging);
        const remoteRefs = new Map([...fetched].map(([ref, oid]) => [
          ref === `${staging}notes` ? NOTES_REF : `${REVIEWS}${ref.slice(`${staging}reviews/`.length)}`, oid,
        ]));
        const result: SyncResult = { remote, downloaded: 0, merged: 0, uploaded: 0, unchanged: 0 };
        const targets: RefMap = new Map();
        for (const ref of [...new Set([...local.keys(), ...remoteRefs.keys()])].sort()) {
          this.validateRef(ref);
          const left = local.get(ref);
          const right = remoteRefs.get(ref);
          let oid: string;
          try { oid = await this.reconcile(ref, left, right); }
          catch (error) { throw new Error(`${ref}: ${error instanceof Error ? error.message : String(error)}`); }
          targets.set(ref, oid);
          if (right && right !== left) result.downloaded++;
          if (left && right && oid !== left && oid !== right) result.merged++;
          if (oid !== right) result.uploaded++;
          if (oid === left && oid === right) result.unchanged++;
        }
        if (!targets.size) return result;
        // Compare-and-swap all local refs in one transaction, including unchanged refs read during sync.
        const commands = [...targets].map(([ref, oid]) => {
          const previous = local.get(ref) ?? '0'.repeat(oid.length);
          return oid === previous ? `verify ${ref} ${previous}` : `update ${ref} ${oid} ${previous}`;
        });
        await this.repository.gitInput(`start\noption no-deref\n${commands.join('\n')}\nprepare\ncommit\n`, 'update-ref', '--stdin');
        published = true;
        if (result.uploaded) {
          // Explicit OIDs prevent an external local writer changing what this invocation pushes.
          // Atomic, non-forced publication either sends the complete result or rejects it.
          await this.repository.network('push', '--atomic', '--no-follow-tags', remote,
            ...[...targets].map(([ref, oid]) => `${oid}:${ref}`));
        }
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(published
          ? `Sync upload failed. Reconciled discussions are saved locally. Check Git credentials/connectivity and retry Sync; a concurrent remote update may require another merge. No force push was used.\n${detail}`
          : `Sync stopped before changing local discussion refs.\n${detail}`);
      } finally {
        const staged = await this.refs(staging);
        if (staged.size) await this.repository.gitInput(
          [...staged].map(([ref, oid]) => `delete ${ref} ${oid}\n`).join(''), 'update-ref', '--stdin');
      }
    });
  }
}
