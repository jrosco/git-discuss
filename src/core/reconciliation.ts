import { z } from 'zod';
import { commentSchema, reviewSchema, type Comment, type Review } from './models.js';

// Compare records independently of JSON property order. Unknown fields must not be silently lost.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function lossless<T>(schema: z.ZodType<T>, text: string): T {
  const raw: unknown = JSON.parse(text);
  const parsed = schema.parse(raw);
  if (canonical(raw) !== canonical(parsed)) throw new Error('Unsupported or noncanonical record fields. Update the application before syncing this history.');
  return parsed;
}

export function parseComments(text: string, commit: string): Comment[] {
  const comments = lossless(z.array(commentSchema), text);
  const seen = new Set<string>();
  for (const item of comments) {
    if (item.commit !== commit || seen.has(item.id) || (item.replyTo && !seen.has(item.replyTo))) {
      throw new Error(`Invalid note history on ${commit}: commit, duplicate ID, or reply target.`);
    }
    seen.add(item.id);
  }
  return comments;
}

export function parseReview(text: string, id: string): Review {
  const review = lossless(reviewSchema, text);
  if (review.id !== id) throw new Error(`Review ID does not match ref ${id}.`);
  return review;
}

// Preserve each writer's existing sequence. Order concurrent records deterministically by time/ID.
// Reply parents already precede their children in validated inputs, so these edges preserve threads.
export function mergeRecords<T extends { id: string; createdAt: string }>(left: T[], right: T[]): T[] {
  const records = new Map<string, T>();
  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const sequence of [left, right]) {
    for (const item of sequence) {
      const existing = records.get(item.id);
      if (existing && canonical(existing) !== canonical(item)) {
        throw new Error(`Sync conflict: record ${item.id} has different contents. Neither version was overwritten.`);
      }
      records.set(item.id, item);
      if (!edges.has(item.id)) { edges.set(item.id, new Set()); incoming.set(item.id, 0); }
    }
    for (let index = 1; index < sequence.length; index++) {
      const before = sequence[index - 1].id;
      const after = sequence[index].id;
      if (!edges.get(before)!.has(after)) {
        edges.get(before)!.add(after);
        incoming.set(after, incoming.get(after)! + 1);
      }
    }
  }
  const ready = [...records.values()].filter(item => incoming.get(item.id) === 0);
  const result: T[] = [];
  while (ready.length) {
    ready.sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
    const item = ready.shift()!;
    result.push(item);
    for (const next of edges.get(item.id)!) {
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) ready.push(records.get(next)!);
    }
  }
  if (result.length !== records.size) throw new Error('Sync conflict: incompatible record ordering. Neither history was overwritten.');
  return result;
}

export function mergeReviews(left: Review, right: Review): Review {
  const { revisions: leftRevisions, comments: leftComments, changes: leftChanges, schema: leftSchema, tracking: leftTracking, ...leftMetadata } = left;
  const { revisions: rightRevisions, comments: rightComments, changes: rightChanges, schema: rightSchema, tracking: rightTracking, ...rightMetadata } = right;
  if (canonical(leftMetadata) !== canonical(rightMetadata)) {
    throw new Error(`Sync conflict: review ${left.id} has different identity or title metadata.`);
  }
  const changes = mergeRecords(leftChanges ?? [], rightChanges ?? []);
  if (leftTracking && rightTracking && canonical(leftTracking) !== canonical(rightTracking)) {
    throw new Error(`Sync conflict: review ${left.id} follows different branches or starting code.`);
  }
  const tracking = leftTracking ?? rightTracking;
  // Tracked code snapshots are a set, not an observation-order log. Two clones can
  // observe commits in different orders after a force push, without creating a cycle.
  const revisions = tracking
    ? mergeRecords([...leftRevisions].sort((a, b) => compare(a.id, b.id)), [...rightRevisions].sort((a, b) => compare(a.id, b.id)))
      .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
    : mergeRecords(leftRevisions, rightRevisions);
  return reviewSchema.parse({ ...leftMetadata, schema: Math.max(leftSchema, rightSchema),
    ...(changes.length ? { changes } : {}),
    ...(tracking ? { tracking } : {}), revisions, comments: mergeComments(leftComments, rightComments) });
}

export function mergeComments<T extends Comment>(left: T[], right: T[]): T[] {
  const combined = new Map<string, T>();
  for (const item of [...left, ...right]) {
    const previous = combined.get(item.id);
    if (!previous) { combined.set(item.id, item); continue; }
    const { changes: a, schema: as, ...originalA } = previous;
    const { changes: b, schema: bs, ...originalB } = item;
    if (canonical(originalA) !== canonical(originalB)) {
      throw new Error(`Sync conflict: record ${item.id} has different contents. Neither version was overwritten.`);
    }
    const changes = mergeRecords(a ?? [], b ?? []);
    combined.set(item.id, { ...item, schema: Math.max(as, bs) as 1 | 2, ...(changes.length ? { changes } : {}) });
  }
  return mergeRecords(left.map(item => combined.get(item.id)!), right.map(item => combined.get(item.id)!));
}
