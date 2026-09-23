import { createHash } from 'node:crypto';
import { Repository } from '../git/repository.js';
import { canonical } from './reconciliation.js';
import { isDeleted } from './changes.js';
import { revisionSchema, trackedBranchSchema, trackingStateSchema, type Review, type ReviewView, type TrackingState } from './models.js';

export const TRACKING_REF = 'refs/git-discuss/tracking/';

export class BranchTracking {
  constructor(readonly repository: Repository) {}

  async sourceFor(ref: string): Promise<{ commit: string; branch: string | null }> {
    let stable = ref;
    if (ref === 'HEAD') {
      const name = await this.repository.git('branch', '--show-current');
      stable = name ? `refs/heads/${name}` : 'HEAD';
    }
    const commit = await this.repository.resolve(stable);
    return { commit, branch: stable === 'HEAD' ? null : await this.branchFor(stable) };
  }

  async branchFor(ref: string): Promise<string | null> {
    let full: string;
    if (ref === 'HEAD') {
      const name = await this.repository.git('branch', '--show-current');
      if (!name) return null;
      full = `refs/heads/${name}`;
    } else {
      full = await this.repository.git('rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', ref);
    }
    if (full.startsWith('refs/heads/')) {
      // A feature branch can have main configured as its upstream. Follow the selected
      // name, not that upstream; choose a remote-tracking branch explicitly for a renamed source.
      return trackedBranchSchema.parse(full);
    }
    if (full.startsWith('refs/remotes/')) {
      for (const remote of (await this.repository.remotes()).sort((a, b) => b.length - a.length)) {
        const prefix = `refs/remotes/${remote}/`;
        if (full.startsWith(prefix)) return trackedBranchSchema.parse(`refs/heads/${full.slice(prefix.length)}`);
      }
      throw new Error('This remote-tracking branch has no configured remote. Choose a local branch or a commit ID.');
    }
    return null;
  }

  async readState(id: string): Promise<{ oid?: string; state?: TrackingState }> {
    const ref = `${TRACKING_REF}${id}`;
    const rows = await this.repository.git('for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref);
    const row = rows.split('\n').map(item => item.split('\0')).find(([name]) => name === ref);
    if (!row) return {};
    if (row[2]) throw new Error('Symbolic review tracking refs are not supported.');
    return { oid: row[1], state: trackingStateSchema.parse(JSON.parse(await this.repository.git('cat-file', 'blob', row[1]))) };
  }

  async cachedRemoteHead(branch: string, source: string, preferred?: string): Promise<string | undefined> {
    const remotes = await this.repository.remotes();
    const fromSource = [...remotes].sort((a, b) => b.length - a.length).find(name => source.startsWith(`refs/remotes/${name}/`) || source.startsWith(`${name}/`));
    const remote = preferred && remotes.includes(preferred) ? preferred : fromSource ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined);
    if (!remote) return undefined;
    const ref = `refs/remotes/${remote}/${branch.slice('refs/heads/'.length)}`;
    const output = await this.repository.git('for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', ref);
    const row = output.split('\n').map(item => item.split('\0')).find(([name]) => name === ref);
    return row?.[2] === 'commit' ? row[1] : undefined;
  }

  revisionFor(review: Review, head: string) {
    return review.revisions.filter(item => item.head === head && item.base === review.tracking?.base)
      .sort((a, b) => a.id < b.id ? -1 : 1)[0];
  }

  async view(review: Review): Promise<ReviewView> {
    if (!review.tracking) return { ...review, currentRevisionId: review.revisions[review.revisions.length - 1].id };
    const stored = (await this.readState(review.id)).state;
    const state = stored?.branch === review.tracking.branch ? stored : {
      branch: review.tracking.branch, head: review.tracking.initialHead, state: 'waiting' as const,
    };
    const observed = this.revisionFor(review, state.head);
    const current = observed ?? this.revisionFor(review, review.tracking.initialHead) ?? review.revisions[0];
    return { ...review, currentRevisionId: current.id, trackingStatus: observed ? state : { ...state, head: current.head, state: 'waiting' } };
  }

  async retain(review: Review, head: string): Promise<Review> {
    if (!review.tracking || this.revisionFor(review, head)) return review;
    const base = review.tracking.base;
    // UUIDv5: the review ID is the namespace, and the exact comparison is the name.
    // Two developers observing the same commit create the same immutable record.
    const bytes = createHash('sha1').update(Buffer.from(review.id.replaceAll('-', ''), 'hex')).update(`${base}:${head}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
    const hex = bytes.toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const details = await this.repository.commitDetails(head);
    const revision = revisionSchema.parse({ id, base, head, source: 'branch',
      subject: await this.repository.git('show', '-s', '--no-show-signature', '--format=%s', head, '--'),
      author: { name: details.author.name || review.author.name, email: details.author.email || review.author.email },
      createdAt: new Date(details.committedAt).toISOString(),
    });
    return { ...review, schema: 3, revisions: [...review.revisions, revision] };
  }

  async prepare(reviews: Review[], remote: string, staging: string, signal?: AbortSignal) {
    const active = reviews.filter(review => review.tracking && !isDeleted(review));
    const branches = [...new Set(active.map(review => trackedBranchSchema.parse(review.tracking!.branch)))].sort();
    const heads = new Map<string, string>();
    // Batches keep explicit fetch refspecs within Windows command-line limits.
    for (let offset = 0; offset < branches.length; offset += 40) {
      signal?.throwIfAborted();
      const batch = branches.slice(offset, offset + 40);
      const advertised = await this.repository.networkWithSignal(signal, 'ls-remote', '--refs', remote, ...batch);
      const found = new Set(advertised ? advertised.split('\n').map(line => line.split('\t')[1]) : []);
      const requested = batch.filter(branch => found.has(branch));
      const specs = requested.map(branch => `${branch}:${staging}code/${branches.indexOf(branch)}`);
      if (specs.length) await this.repository.networkWithSignal(signal, 'fetch', '--atomic', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, ...specs);
      for (const branch of requested) heads.set(branch, await this.repository.resolve(`${staging}code/${branches.indexOf(branch)}`));
    }
    const prepared: { review: Review; stateRef: string; previous?: string; stateOid: string; stateChanged: boolean }[] = [];
    for (const review of active) {
      signal?.throwIfAborted();
      const tracking = review.tracking!;
      const old = await this.readState(review.id);
      const previous = old.state?.branch === tracking.branch && old.state.remote === remote ? old.state : undefined;
      const head = heads.get(tracking.branch);
      let state: TrackingState;
      let next = review;
      if (!head) {
        state = { ...previous, branch: tracking.branch, head: previous?.head ?? tracking.initialHead, remote, state: 'missing' };
      } else {
        const initialBehind = !previous?.observed && head !== tracking.initialHead && !this.revisionFor(review, head)?.source &&
          tracking.initialRemoteHead !== tracking.initialHead &&
          (await this.repository.isAncestor(head, tracking.initialHead) ||
            (head === tracking.initialRemoteHead && !await this.repository.isAncestor(tracking.initialHead, head)));
        const waiting = initialBehind || (previous?.awaitingPush && previous.observed === head);
        if (waiting) state = { branch: tracking.branch, head: tracking.initialHead, observed: head, remote, state: 'awaiting-push', awaitingPush: true };
        else {
          next = await this.retain(review, head);
          state = { branch: tracking.branch, head, observed: head, remote, state: 'following' };
        }
      }
      const stateOid = await this.repository.gitInput(canonical(state), 'hash-object', '-w', '--stdin');
      prepared.push({ review: next, stateRef: `${TRACKING_REF}${review.id}`, previous: old.oid, stateOid, stateChanged: old.oid !== stateOid });
    }
    return prepared;
  }
}
