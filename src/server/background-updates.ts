import { backgroundUpdatesInputSchema, type BackgroundUpdateStatus } from '../core/models.js';
import { Synchronization } from '../core/sync.js';

/** One receive-only worker per server; no timer overlap and no credentials prompts. */
export class BackgroundUpdates {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private foreground = 0;
  private failures = 0;
  private state: BackgroundUpdateStatus;

  constructor(private readonly synchronization: Synchronization, private readonly intervalMs = 60000) {
    this.state = { enabled: false, remote: null, running: false, paused: false, intervalSeconds: intervalMs / 1000,
      revision: 0, lastCheckedAt: null, lastSuccessAt: null, nextCheckAt: null, error: null };
  }

  status(): BackgroundUpdateStatus { return { ...this.state, paused: this.foreground > 0 }; }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.state.nextCheckAt = null;
  }

  private schedule(delay = this.intervalMs) {
    this.clearTimer();
    if (this.closed || !this.state.enabled || this.foreground || this.active) return;
    this.state.nextCheckAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => { this.clearTimer(); this.checkNow(); }, delay);
    this.timer.unref();
  }

  private async cancelRun() {
    this.clearTimer();
    this.controller?.abort();
    await this.active;
    this.clearTimer();
  }

  async configure(input: { enabled: boolean; remote: string }): Promise<BackgroundUpdateStatus> {
    const parsed = backgroundUpdatesInputSchema.parse(input);
    if (this.closed) throw new Error('The local server is closing.');
    if (parsed.enabled && (parsed.remote.startsWith('-') || !(await this.synchronization.repository.remotes()).includes(parsed.remote))) {
      throw new Error('Choose a configured Git remote for automatic updates.');
    }
    await this.cancelRun();
    if (this.closed) throw new Error('The local server is closing.');
    this.state.enabled = parsed.enabled; this.state.remote = parsed.remote;
    this.state.error = null; this.state.lastCheckedAt = null; this.state.lastSuccessAt = null; this.failures = 0;
    this.schedule(0);
    return this.status();
  }

  checkNow(): BackgroundUpdateStatus {
    if (this.closed || !this.state.enabled || !this.state.remote || this.foreground || this.active) return this.status();
    this.clearTimer();
    const controller = new AbortController();
    this.controller = controller;
    const remote = this.state.remote;
    this.state.running = true;
    this.active = (async () => {
      try {
        const result = await this.synchronization.receive({ remote }, controller.signal);
        if (result.updatedRefs.length) this.state.revision++;
        this.state.lastSuccessAt = new Date().toISOString(); this.state.error = null; this.failures = 0;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.state.error = error instanceof Error ? error.message : String(error);
          this.failures++;
        }
      } finally {
        if (!controller.signal.aborted) this.state.lastCheckedAt = new Date().toISOString();
        this.state.running = false; this.active = undefined; this.controller = undefined;
        this.schedule(Math.min(this.intervalMs * 2 ** Math.min(this.failures, 3), 300000));
      }
    })();
    return this.status();
  }

  async withForeground<T>(operation: () => Promise<T>): Promise<T> {
    this.foreground++;
    try { await this.cancelRun(); return await operation(); }
    finally { this.foreground--; this.schedule(); }
  }

  async close(): Promise<void> {
    this.closed = true; this.state.enabled = false;
    await this.cancelRun();
  }
}
