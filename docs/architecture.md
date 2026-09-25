# Architecture and storage

## Components

```text
src/cli.ts       CLI entry point
src/core/        Review rules, validation, reconciliation, synchronization
src/git/         Git subprocesses and notes storage
src/server/      Local HTTP API and browser asset hosting
src/web/         React review, notes, and sharing workspaces
src-tauri/       Cross-platform tray host
```

The Tauri tray host starts one bundled Node server per open repository. Each server binds to loopback and opens the existing web interface in the default browser. The tray tracks recent and running repositories and shuts down all child servers when quitting. The desktop package includes a Node runtime and production server dependencies.

## Review storage

Each review is stored at `refs/git-discuss/reviews/<review-id>` as validated `review.json` in a Git commit. The record contains stable review identity, title, author, creation time, exact base/head comparisons, comments, and optional branch tracking metadata. Current tracking observations are private data at `refs/git-discuss/tracking/<review-id>` and are not pushed.

Each write creates a new snapshot commit. Review snapshots link their base/head code commits as parents to retain reviewed code even after branches are rewritten or deleted. Writers share a repository-scoped lock and use compare-and-swap ref updates. Sync publishes local ref changes atomically.

## Commit-linked notes

Plain-text/Markdown notes are stored on annotated commits at `refs/notes/git-discuss`. Editing, appending, or deleting changes the current notes tree while retaining previous versions in Git history. Sync adds code-retention parent links before sharing notes. Read a note with:

```sh
git notes --ref=git-discuss show <commit>
git log --first-parent refs/notes/git-discuss
```

## Boundaries

- Branch-following reviews follow the selected source branch while preserving exact discussion anchors. The base is fixed; following a moving base branch is not implemented.
- Standalone commit notes stay attached to the exact commit.
- Normal Git fetch/push does not transfer Git Discuss refs; use `git discuss sync`.
- The loopback server is for local use, not a network service.
- Git author identity and timestamps are recorded as metadata, not verified signatures.
- Git notes are not secure erasure: previous text remains in Git history.
- The app lock coordinates this application's writers, not external `git notes` commands. A crash can leave `git-discuss.lock` in the directory returned by `git rev-parse --git-common-dir`; remove it only after stopping writers.

Review snapshots use schema version 3 for tracked reviews; older pinned reviews use versions 1/2. Clients need compatible versions to read newer tracking/resolution records.

See the [technical reference](technical-reference.md) for API authentication, tracking edge cases, and reconciliation behavior.
