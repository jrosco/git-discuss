# Sharing and sync

Git Discuss stores reviews and commit notes in Git and exchanges them through an existing remote. There is no application account or separate review service.

## Set up a team remote

Both developers need access to the same Git remote. Git Discuss uses `git-discuss.remote` when set; otherwise it uses `origin`, or the first configured remote if `origin` is absent. In the browser, choose a remote under **Sharing settings & help** → **Team repository**. From the CLI:

```sh
git remote -v
git remote add origin <repository-url>   # only if needed
git config set --local git-discuss.remote origin
git discuss sync
```

The selected remote is saved in the repository’s `.git/config`. Override it for one command with `git discuss sync --remote <name>`.

Configure SSH or credential-manager authentication in Git first. The selected remote must have one matching fetch/push URL and support custom refs and atomic pushes. Split URLs or multiple push destinations need a separate single-destination remote.

`git discuss sync` fetches, reconciles, and pushes `refs/notes/git-discuss` and `refs/git-discuss/reviews/*`. Normal `git clone`, `fetch`, and `push` do not transfer these discussion refs automatically. Code branches remain under normal Git control; sync never pushes branch tips or changes checked-out files.

## Background updates

In **Sharing settings & help**, select a team remote and enable **Check for team updates automatically**. This preference is saved as `git-discuss.updates.enabled` in the repository’s `.git/config`; it can also be set with `git config set --local git-discuss.updates.enabled true` (or `false`). Enabled checks start when Git Discuss starts, run immediately, then once per minute after the prior check finishes. **Check now** requests a receive-only check. Background checks never overlap or push local feedback.

The server fetches discussion refs and the source branches of active tracked reviews. New feedback or code produces **New code or feedback available → Show updates**. Content stays as loaded until updates are shown. Drafts and intentionally selected historical comparisons remain pinned; an idle view of current code advances to the received commit.

Network and reconciliation failures appear as **Updates paused — will retry**. Retries back off up to five minutes; you can also choose **Check now**. Closing a browser tab does not stop an enabled server-side worker; quit the tray app or stop `git discuss serve` to stop it.

## Conflicts and failures

Review comments and edits merge by immutable ID and retain history. Tracked code comparisons are deduplicated by base/head. Plain notes merge per commit using common notes history: independent changes can merge, while conflicting replacements stop sync before it publishes local refs. The application does not silently choose a winning note.

Resolve a plain-note conflict manually with Git after stopping the local application server:

```sh
git fetch origin refs/notes/git-discuss:refs/notes/git-discuss-incoming
git notes --ref=git-discuss merge -s manual refs/notes/git-discuss-incoming
# Resolve any Git-reported conflict in the NOTES_MERGE_WORKTREE path.
git notes --ref=git-discuss merge --commit
git discuss sync
```

Sync publishes reconciled refs in one guarded transaction, then uses an atomic non-forced push. If upload fails, reconciled work remains saved locally; retry sync after resolving connectivity or remote updates. There is no partial-push fallback. Authentication and network subprocesses are noninteractive and have a two-minute timeout.

See [Storage and architecture](architecture.md) for ref layout and reconciliation details.
