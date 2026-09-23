import { useEffect, useRef, useState } from 'react';
import type { BackgroundUpdateStatus, SyncResult } from '../core/models.js';
import { api, errorMessage } from './api.js';
import { ErrorNotice } from './components.js';

export function SharingPanel({ busy, localChanges, onBusy, onFinished, onBackgroundRevision, onBackgroundSummary, onRemoteChange, externalResult }: {
  busy: boolean; localChanges: boolean; onBusy: (busy: boolean) => void; onFinished: (success: boolean) => void;
  onBackgroundRevision: (revision: number) => void;
  onBackgroundSummary: (summary: BackgroundUpdateStatus['latestChangeSummary']) => void;
  onRemoteChange: (remote: string) => void;
  externalResult: SyncResult | null;
}) {
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remote, setRemote] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SyncResult | null>(null);
  const [lastShared, setLastShared] = useState('');
  const [background, setBackground] = useState<BackgroundUpdateStatus | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null);
  const [backgroundError, setBackgroundError] = useState('');
  const [statusError, setStatusError] = useState(false);
  const statusEpoch = useRef(0);
  function summaryText(summary: BackgroundUpdateStatus['latestChangeSummary']) {
    if (!summary || (!summary.notesUpdated && summary.reviewsUpdated === 0)) return '';
    const reviews = summary.reviewsUpdated > 0 ?
      `${summary.reviewsUpdated} ${summary.reviewsUpdated === 1 ? 'review' : 'reviews'} updated` : '';
    const notes = summary.notesUpdated ? 'change notes updated' : '';
    const ids = summary.sampleReviewIds.length ? ` (${summary.sampleReviewIds.slice(0, 5).map(id => id.slice(0, 8)).join(', ')})` : '';
    const commits = summary.sampleNoteCommits.length ? ` [${summary.sampleNoteCommits.slice(0, 5).map(id => id.slice(0, 8)).join(', ')}]` : '';
    if (reviews && notes) return `${reviews} and ${notes}${ids}${commits}.`;
    if (reviews) return `${reviews}${ids}.`;
    return `${notes}${commits}.`;
  }
  useEffect(() => { onRemoteChange(loading || settingsBusy ? '' : remote); }, [remote, loading, settingsBusy, onRemoteChange]);
  useEffect(() => { if (busy) setResult(null); }, [busy]);
  useEffect(() => {
    if (externalResult) { setResult(externalResult); setLastShared(new Date().toLocaleTimeString()); }
  }, [externalResult]);
  function showStatus(status: BackgroundUpdateStatus) {
    statusEpoch.current++;
    setBackground(status); onBackgroundRevision(status.revision);
    onBackgroundSummary(status.latestChangeSummary);
    setStatusError(false);
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const epoch = statusEpoch.current;
      try {
        const status = await api<BackgroundUpdateStatus>('background-updates');
        if (active && epoch === statusEpoch.current) showStatus(status);
      } catch { if (active && epoch === statusEpoch.current) setStatusError(true); }
      finally { if (active) timer = setTimeout(() => void poll(), 5000); }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [onBackgroundRevision]);

  async function configureBackground(enabled: boolean, nextRemote = remote) {
    statusEpoch.current++;
    setSettingsBusy(true); setRequestedEnabled(enabled); setBackgroundError('');
    try { showStatus(await api<BackgroundUpdateStatus>('background-updates', { enabled, remote: nextRemote })); }
    catch (error) { setBackgroundError(errorMessage(error)); }
    finally { setSettingsBusy(false); setRequestedEnabled(null); }
  }

  async function checkNow() {
    statusEpoch.current++;
    setSettingsBusy(true); setBackgroundError('');
    try { showStatus(await api<BackgroundUpdateStatus>('background-updates/check', {})); }
    catch (error) { setBackgroundError(errorMessage(error)); }
    finally { setSettingsBusy(false); }
  }
  async function loadRemotes() {
    setLoading(true); setError('');
    try {
      const [names, status] = await Promise.all([api<string[]>('remotes'), api<BackgroundUpdateStatus>('background-updates')]);
      setRemotes(names);
      showStatus(status);
      setRemote(current => names.includes(current) ? current : status.enabled && status.remote && names.includes(status.remote) ? status.remote : names.includes('origin') ? 'origin' : names[0] ?? '');
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
    finally {
      try { showStatus(await api<BackgroundUpdateStatus>('background-updates')); } catch { setStatusError(true); }
      onBusy(false); onFinished(success);
    }
  }
  return <section className="card sharing-panel" aria-label="Share with your team">
    <div className="sharing-main"><div>
      <h2>Share with your team</h2>
      <p>{localChanges ? 'You have new feedback or review changes saved on this computer.' : 'Send saved reviews and notes, and get your teammates’ latest code and feedback.'}</p>
      <small>{remote ? `Team repository: ${remote}` : 'Connect to your team’s repository to exchange feedback.'}{lastShared && ` · Last successful exchange at ${lastShared}`}</small>
    </div><button id="share-button" type="button" disabled={busy || loading || settingsBusy || !remote} onClick={() => void sync()}>{busy ? 'Sharing & getting updates…' : 'Share & get updates'}</button></div>
    <details className="sharing-settings" open={!loading && remotes.length === 0 ? true : undefined}>
      <summary>Sharing settings & help</summary>
      <label htmlFor="sharing-remote">Team repository</label>
      <div className="row"><select id="sharing-remote" value={remote} disabled={busy || loading || settingsBusy || !remotes.length} onChange={event => {
        const next = event.target.value;
        setRemote(next); setResult(null); setLastShared(''); setError('');
        if (background?.enabled) void configureBackground(true, next);
      }}>
        {!remotes.length && <option value="">{loading ? 'Finding repositories…' : 'No team repository connected'}</option>}
        {remotes.map(name => <option key={name} value={name}>{name}</option>)}
      </select><button type="button" className="secondary-button" disabled={busy || loading || settingsBusy} onClick={() => void loadRemotes()}>Refresh connections</button></div>
      <div className="automatic-updates-setting">
        <label className="checkbox-label"><input type="checkbox" checked={requestedEnabled ?? background?.enabled ?? false}
          disabled={busy || loading || settingsBusy || !background || (!remote && !background.enabled)}
          onChange={event => void configureBackground(event.target.checked, remote || background?.remote || 'origin')} />
          Check for team updates automatically</label>
        <p>Checks every minute for team feedback and commits pushed to tracked review branches. Upload feedback using Share & get updates. Push your code using your usual Git tools.</p>
        <button type="button" className="secondary-button" disabled={busy || settingsBusy || !background?.enabled || background.running} onClick={() => void checkNow()}>Check now</button>
        <p className="field-hint">This setting applies to all browser tabs connected to this server and resets when the server restarts.</p>
        <ErrorNotice message={backgroundError} />
      </div>
      <p>A team repository is the shared Git location your team uses. Git calls this a <strong>remote</strong>; <code>origin</code> is its usual nickname.</p>
      {!loading && !remotes.length && <div className="inline-hint">Ask your project maintainer to connect this project to the team repository.
        <details><summary>Setup command for Git users</summary><code>git remote add origin &lt;repository-url&gt;</code><p>Then choose Refresh connections above.</p></details>
      </div>}
      <p>This exchanges all saved reviews and change notes using your existing Git access. Draft text is not shared. Code snapshots referenced by this feedback travel with them.</p>
      <p>Edits and deletions made here are shared too. Review comment deletions keep review replies in place, and previous text remains in Git history.</p>
    </details>
    <div className="background-status" aria-live="polite">
      {statusError ? 'Update status unavailable — will retry.' : background?.enabled
        ? background.paused ? 'Automatic checks paused while saving or sharing.'
          : background.running ? `Checking ${background.remote} for team feedback…`
            : background.error ? 'Updates paused — will retry automatically. Your local work is still available.'
              : `Automatic updates on · ${background.remote}${background.lastSuccessAt ? ` · Last checked ${new Date(background.lastSuccessAt).toLocaleTimeString()}` : ''}`
        : 'Automatic updates off · Enable them in Sharing settings & help.'}
    </div>
    {background?.latestChangeSummary && summaryText(background.latestChangeSummary) &&
      <p className="field-hint">Last update from {background.latestChangeSummary.remote}: {summaryText(background.latestChangeSummary)}</p>}
    {background?.error && <details className="background-error"><summary>Update check details</summary><pre>{background.error}</pre></details>}
    {busy && <p role="status" className="inline-hint">Getting team feedback, combining saved additions, and sharing your updates. Keep Git Discuss running until this finishes.</p>}
    <ErrorNotice message={error} />
    {result && <div className="notice" role="status">
      <strong>{result.downloaded === 0 && result.uploaded === 0 ? 'No new feedback to exchange.' : `Saved discussions exchanged with ${result.remote}.`}</strong>
      <p>{localChanges ? 'You have saved more changes since that exchange. Share again when ready.' : 'Your team can get shared feedback using the same button in their copy of the project.'}</p>
      <details><summary>Exchange details</summary><p>Discussion storage refs: {result.downloaded} downloaded · {result.merged} combined · {result.uploaded} uploaded · {result.unchanged} unchanged. These count stored discussion histories, not individual comments.</p></details>
    </div>}
  </section>;
}
