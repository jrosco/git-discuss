import type { SyncResult } from '../core/models.js';

export interface ComposerSharing {
  remote: string;
  successVersion: number;
  onSharing: (busy: boolean) => void;
  onShared: (result: SyncResult | null) => void;
}

export type SubmissionResult =
  | { kind: 'local' }
  | { kind: 'shared'; result: SyncResult }
  | { kind: 'saved-unshared'; error: string };

/** Acknowledge the save before starting network sync so upload retries never repost feedback. */
export async function submitFeedback<T>(save: () => Promise<T>, onSaved: (comment: T) => void,
  share?: () => Promise<SyncResult>): Promise<SubmissionResult> {
  const comment = await save();
  onSaved(comment);
  if (!share) return { kind: 'local' };
  try { return { kind: 'shared', result: await share() }; }
  catch (error) { return { kind: 'saved-unshared', error: error instanceof Error ? error.message : String(error) }; }
}
