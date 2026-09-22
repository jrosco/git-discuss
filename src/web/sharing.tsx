import { useEffect, useState } from 'react';
import type { SyncResult } from '../core/models.js';
import { api, errorMessage } from './api.js';
import { ErrorNotice } from './components.js';

export function SharingPanel({ busy, localChanges, onBusy, onFinished }: {
  busy: boolean; localChanges: boolean; onBusy: (busy: boolean) => void; onFinished: (success: boolean) => void;
}) {
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remote, setRemote] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SyncResult | null>(null);
  const [lastShared, setLastShared] = useState('');
  async function loadRemotes() {
    setLoading(true); setError('');
    try {
      const names = await api<string[]>('remotes');
      setRemotes(names);
      setRemote(current => names.includes(current) ? current : names.includes('origin') ? 'origin' : names[0] ?? '');
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadRemotes(); }, []);
  async function sync() {
    onBusy(true); setError(''); setResult(null);
    let success = false;
    try {
      setResult(await api<SyncResult>('sync', { remote }));
      setLastShared(new Date().toLocaleTimeString()); success = true;
    } catch (error) { setError(errorMessage(error)); }
    finally { onBusy(false); onFinished(success); }
  }
  return <section className="card sharing-panel" aria-label="Share with your team">
    <div className="sharing-main"><div>
      <h2>Share with your team</h2>
      <p>{localChanges ? 'You have new feedback or versions saved on this computer.' : 'Send saved reviews and notes, and get your teammates’ latest feedback.'}</p>
      <small>{remote ? `Team repository: ${remote}` : 'Connect to your team’s repository to exchange feedback.'}{lastShared && ` · Last successful exchange at ${lastShared}`}</small>
    </div><button id="share-button" type="button" disabled={busy || loading || !remote} onClick={() => void sync()}>{busy ? 'Sharing & getting updates…' : 'Share & get updates'}</button></div>
    <details className="sharing-settings" open={!loading && remotes.length === 0 ? true : undefined}>
      <summary>Sharing settings & help</summary>
      <label htmlFor="sharing-remote">Team repository</label>
      <div className="row"><select id="sharing-remote" value={remote} disabled={busy || loading || !remotes.length} onChange={event => {
        setRemote(event.target.value); setResult(null); setLastShared(''); setError('');
      }}>
        {!remotes.length && <option value="">{loading ? 'Finding repositories…' : 'No team repository connected'}</option>}
        {remotes.map(name => <option key={name} value={name}>{name}</option>)}
      </select><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void loadRemotes()}>Refresh connections</button></div>
      <p>A team repository is the shared Git location your team uses. Git calls this a <strong>remote</strong>; <code>origin</code> is its usual nickname.</p>
      {!loading && !remotes.length && <div className="inline-hint">Ask your project maintainer to connect this project to the team repository.
        <details><summary>Setup command for Git users</summary><code>git remote add origin &lt;repository-url&gt;</code><p>Then choose Refresh connections above.</p></details>
      </div>}
      <p>This exchanges all saved reviews and change notes using your existing Git access. Draft text is not shared. Code snapshots referenced by the discussions travel with them.</p>
      <p>Edits and deletions made here are shared too. Deleted comments keep replies in place, and previous text remains in Git history.</p>
    </details>
    {busy && <p role="status" className="inline-hint">Getting team feedback, combining saved additions, and sharing your updates. Keep Git Discuss running until this finishes.</p>}
    <ErrorNotice message={error} />
    {result && <div className="notice" role="status">
      <strong>{result.downloaded === 0 && result.uploaded === 0 ? 'No new feedback to exchange.' : `Saved discussions exchanged with ${result.remote}.`}</strong>
      <p>{localChanges ? 'You have saved more changes since that exchange. Share again when ready.' : 'Your team can get shared feedback using the same button in their copy of the project.'}</p>
      <details><summary>Exchange details</summary><p>Discussion storage refs: {result.downloaded} downloaded · {result.merged} combined · {result.uploaded} uploaded · {result.unchanged} unchanged. These count stored discussion histories, not individual comments.</p></details>
    </div>}
  </section>;
}
