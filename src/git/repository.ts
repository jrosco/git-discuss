import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { commitListInputSchema, noteCountsInputSchema, type BranchChoice, type CommitPage, type CommitDetails, type NoteCounts } from '../core/models.js';

const execute = promisify(execFile);
export const NOTES_REF = 'refs/notes/git-discuss';

export class Repository {
  private constructor(readonly root: string, private readonly commonDir: string) {}

  static async open(directory: string): Promise<Repository> {
    const run = async (...args: string[]) => {
      const { stdout } = await execute('git', ['-C', directory, ...args], { encoding: 'utf8' });
      return stdout.trim();
    };
    try {
      const root = await run('rev-parse', '--show-toplevel');
      const commonDir = await run('rev-parse', '--path-format=absolute', '--git-common-dir');
      return new Repository(root, commonDir);
    } catch {
      throw new Error('Choose an existing Git working tree with --repo <path>.');
    }
  }

  async git(...args: string[]): Promise<string> {
    return (await this.gitRaw(...args)).trim();
  }

  async gitRaw(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execute('git', ['-C', this.root, ...args], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(detail.stderr?.trim() || detail.message);
    }
  }

  async network(...args: string[]): Promise<string> {
    return this.networkWithSignal(undefined, ...args);
  }

  async networkWithSignal(signal: AbortSignal | undefined, ...args: string[]): Promise<string> {
    try {
      const { stdout } = await execute('git', ['-C', this.root, ...args], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
      return stdout.trim();
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(detail.stderr?.trim() || detail.message);
    }
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await execute('git', ['-C', this.root, 'merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }

  async mergeBases(left: string, right: string): Promise<string[]> {
    try {
      const { stdout } = await execute('git', ['-C', this.root, 'merge-base', '--all', left, right], { encoding: 'utf8' });
      return stdout.trim() ? stdout.trim().split('\n') : [];
    } catch (error) {
      if ((error as { code?: number }).code === 1) return [];
      throw error;
    }
  }

  async remotes(): Promise<string[]> {
    const output = await this.git('remote');
    return output ? output.split('\n') : [];
  }

  async resolve(ref: string): Promise<string> {
    try {
      return await this.git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
    } catch {
      throw new Error(`Cannot resolve commit "${ref}". The repository must have a commit.`);
    }
  }

  async diff(base: string, head: string): Promise<string> {
    // Only immutable commit IDs are accepted here; preserve patch whitespace exactly.
    if (![base, head].every(id => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))) {
      throw new Error('Diff endpoints must be exact commit IDs.');
    }
    const tooLarge = 'This diff is too large for the browser (limit: 2 MiB or 20,000 lines). Inspect it locally with git diff <base> <head>.';
    try {
      const { stdout } = await execute('git', ['-C', this.root, 'diff',
        '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--no-renames',
        '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--diff-algorithm=myers',
        '--submodule=short', '--ignore-submodules=none', base, head, '--'],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
      if (stdout.split('\n').length > 20000) throw new Error(tooLarge);
      return stdout;
    } catch (error) {
      const detail = error as Error & { code?: string; stderr?: string };
      if (detail.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(tooLarge);
      throw new Error(detail.stderr?.trim() || detail.message);
    }
  }

  async branches(): Promise<BranchChoice[]> {
    const output = await this.git('for-each-ref', '--sort=refname',
      '--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)%00%(HEAD)', 'refs/heads/', 'refs/remotes/');
    return output ? output.split('\n').flatMap(line => {
      const [ref, commit, symbolic, type, current] = line.split('\0');
      if (symbolic || type !== 'commit') return [];
      const remote = ref.startsWith('refs/remotes/');
      return [{ ref, commit, remote, current: current === '*',
        name: ref.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length) }];
    }) : [];
  }

  async commits(input: { ref?: string; offset?: number; limit?: number } = {}): Promise<CommitPage> {
    const { ref, offset, limit } = commitListInputSchema.parse(input);
    const tip = await this.resolve(ref);
    // Walk only the chosen commit's ancestors, never notes or review metadata refs.
    const output = await this.git('log', '--no-show-signature', '--no-notes', '--no-decorate', '--date-order',
      '-z', '--format=%H%x00%an%x00%aI%x00%s', `--max-count=${limit + 1}`, `--skip=${offset}`, tip, '--');
    const fields = output.split('\0');
    const commits: CommitPage['commits'] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      commits.push({ commit: fields[index], author: fields[index + 1], authoredAt: fields[index + 2], subject: fields[index + 3], noteCount: 0 });
    }
    const page = commits.slice(0, limit);
    const counts = await this.noteCounts(page.map(item => item.commit));
    return { tip, commits: page.map(item => ({ ...item, noteCount: counts[item.commit] })), nextOffset: commits.length > limit ? offset + limit : null };
  }

  async noteCounts(commits: string[]): Promise<NoteCounts> {
    noteCountsInputSchema.parse({ commits });
    const counts: NoteCounts = Object.fromEntries(commits.map(commit => [commit, 0]));
    if (!commits.length) return counts;
    // Read the notes index once and only inspect blobs for the requested code commits.
    // Blob IDs pin the snapshot if another writer updates the notes ref during counting.
    const entries = await this.git('notes', `--ref=${NOTES_REF}`, 'list');
    for (const line of entries ? entries.split('\n') : []) {
      const [blob, commit] = line.split(' ');
      if (!Object.hasOwn(counts, commit)) continue;
      const text = await this.git('cat-file', 'blob', blob);
      counts[commit] = text.trim().length ? 1 : 0;
    }
    return counts;
  }

  async readNote(commit: string): Promise<string | null> {
    return (await this.noteSnapshot(commit)).note;
  }

  async commitDetails(commit: string): Promise<CommitDetails> {
    const output = await this.git('show', '-s', '--no-show-signature', '--no-notes',
      '--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', commit, '--');
    const [tree, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt] = output.split('\0');
    return {
      tree, parents: parents ? parents.split(' ') : [],
      author: { name: authorName, email: authorEmail }, authoredAt,
      committer: { name: committerName, email: committerEmail }, committedAt,
    };
  }

  async noteSnapshot(commit: string): Promise<{ note: string | null; noteVersion: string | null }> {
    const entries = await this.git('notes', `--ref=${NOTES_REF}`, 'list');
    const entry = entries.split('\n').map(line => line.split(' ')).find(([, target]) => target === commit);
    if (!entry) return { note: null, noteVersion: null };
    return { note: await this.gitRaw('cat-file', 'blob', entry[0]), noteVersion: entry[0] };
  }

  async writeNote(commit: string, contents: string): Promise<void> {
    // Reuse an exact blob: Git's default stripspace would otherwise alter Markdown indentation
    // and trailing spaces, including the two-space hard-line-break syntax.
    const blob = await this.gitInput(contents, 'hash-object', '-w', '--stdin');
    await this.git('notes', `--ref=${NOTES_REF}`, 'add', '-f', '--allow-empty', '-C', blob, commit);
  }

  async removeNote(commit: string): Promise<void> {
    if ((await this.noteSnapshot(commit)).noteVersion === null) return;
    await this.git('notes', `--ref=${NOTES_REF}`, 'remove', commit);
  }

  async appendNote(commit: string, contents: string): Promise<void> {
    const existing = await this.readNote(commit);
    await this.writeNote(commit, existing === null ? contents : `${existing}\n\n${contents}`);
  }

  async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.commonDir, 'git-discuss.lock');
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Another Git Discuss write is active. Retry shortly. If a process crashed, remove git-discuss.lock in the Git common directory after stopping all writers.');
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rmdir(lock);
    }
  }

  async gitInput(input: string, ...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-C', this.root, ...args],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout.trim());
        });
      child.stdin?.on('error', reject);
      child.stdin?.end(input);
    });
  }

  async reviewRefs(): Promise<{ ref: string; oid: string }[]> {
    const output = await this.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/git-discuss/reviews/');
    return output ? output.split('\n').map(line => {
      const [ref, oid] = line.split(' ');
      return { ref, oid };
    }) : [];
  }

  async readReviewSnapshot(oid: string): Promise<string> {
    return this.git('show', `${oid}:review.json`);
  }

  async writeReviewSnapshot(ref: string, previous: string | undefined, contents: string, retained: string[]): Promise<void> {
    const blob = await this.gitInput(contents, 'hash-object', '-w', '--stdin');
    const tree = await this.gitInput(`100644 blob ${blob}\treview.json\n`, 'mktree');
    // Parent links keep both old snapshots and reviewed code reachable through GC.
    const parents = [...new Set([...(previous ? [previous] : []), ...retained])];
    const commit = await this.gitInput('Git Discuss review snapshot\n', '-c', 'commit.gpgsign=false',
      'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]));
    await this.git('update-ref', ref, commit, previous ?? '0'.repeat(commit.length));
  }
}
