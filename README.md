# Git Review App

A TypeScript foundation for Git-native review conversations. The working CLI name is **git discuss** (the name `git review` is already used by Gerrit's tool).

## Requirements

- Node.js 22.12+ and npm
- Git on PATH
- An existing Git working tree with at least one commit
- Git `user.name` and `user.email` configured to post comments

## Quick start

Run from this project directory:

```powershell
npm.cmd install
npm.cmd run build
node dist/cli.js --repo "C:\path\to\your\repository" serve
```

On Windows, `npm.cmd` avoids PowerShell execution-policy restrictions on `npm.ps1`. On macOS/Linux, use `npm`.

The server binds only to `127.0.0.1`, picks an available port, and opens your browser. Use the complete printed URL, including its authentication fragment. Stop it with Ctrl+C.

```powershell
# Optional: register the git-discuss executable on your PATH
npm.cmd link

# Run inside a repository, or supply --repo
git discuss serve
git discuss serve --commit main --port 43821 --no-open
git discuss comment "Could we simplify this?" --commit HEAD
git discuss comment "Agreed." --reply-to <comment-id>
git discuss show --commit HEAD
```

Without linking, use `node dist/cli.js` instead of `git discuss`. The source CLI is available through `npm.cmd run cli -- --repo <path> show`; the UI server must run from the built distribution.

If Git reports that `discuss` is not a command, run `npm.cmd link` from this project directory, then check `git discuss --help`. Repository paths and branch names in the examples are placeholders: use branches that exist in the repository you are reviewing.

## Included

- Shared review engine used by the CLI and HTTP API
- Stable UUID review identities and append-only revisions with retained base/head commits
- Review-wide threaded discussions with explicit revision context
- Readable CLI review lists, unambiguous short IDs, latest-revision comments, and local review deletion
- Read-only unified diffs of retained review revisions in the browser
- One-command / one-click sync of reviews and commit notes with a configured Git remote
- Add-only reconciliation of concurrent comments and revisions, with atomic publication
- Commit selection, threaded plain-text comments, replies, refresh, and error handling
- Git author identity, UTC timestamps, UUID comment IDs, and schema validation
- Persistent notes at `refs/notes/git-discuss`
- Repository-scoped write lock shared by application instances and linked worktrees
- Loopback server with launch token, Host/Origin checks, and same-origin UI
- Integration tests against real temporary Git repositories

Posting saves locally. It does not push, stage files, alter code commits, or create application commits in your working branch. Git notes have their own history. The project directory itself does not need to be initialized as a Git repository to run the application against another repository.

## Stable reviews

Create a review with an explicit base and head (head defaults to `HEAD`):

```powershell
git discuss review create "Simplify cache invalidation" --base main --head feature/cache
git discuss review list
git discuss review list --json
git discuss review show <review-id>
# Defaults to the latest revision and prints the exact revision and head used
git discuss review comment <review-id> "Why invalidate here?"
# Select an older revision explicitly when needed
git discuss review comment <review-id> "Why invalidate here?" --revision <revision-id>

# After new commits, a rebase, or a squash, retain another revision under the same review ID
git discuss review revise <review-id> --base main --head feature/cache
git discuss review comment <review-id> "Updated the approach." --revision <new-revision-id> --reply-to <comment-id>
```

Creation and revision commands print JSON containing the review and revision IDs. Revisions capture exact base/head commits at the time of the command; they do not follow branch names. The base is supplied explicitly, not inferred as a merge base. Identical base/head pairs to the latest revision are rejected as redundant. Other pairs, including unrelated histories, are supported.

`review list` prints a table with review ID, latest revision ID, revision count, comment count, and title. Use `review list --json` for the previous complete JSON output in scripts. The top-level `id` in JSON is the review ID; IDs inside `revisions` identify revisions. `review show` continues to print complete JSON.

All review commands accept an unambiguous review ID prefix of at least four characters. Review comments also accept revision and reply-target prefixes. The list displays eight-character prefixes, lengthened when necessary to distinguish IDs. Ambiguous prefixes fail with matching full IDs so you can supply more characters. Full UUIDs still work.

For example, if `review list` shows review `78db5a4d`:

```powershell
git discuss review show 78db5a4d
git discuss review comment 78db5a4d "Looks good"
git discuss review comment 78db5a4d "About the older version" --revision 6f39c9ea
```

The review ID is positional; `--revision` is optional and may only appear once. Omitting it chooses the latest revision while holding the write lock. Posting always prints the full revision ID and head commit used, including when replying to a comment on an older revision.

### Using the browser

The browser opens in **Reviews**, with readable review cards and a **Start a review** button. You can find a review by title or author, see its version/comment counts, and open it without entering any IDs. The first-use screen explains the three steps: choose changes, leave feedback, and share with the team.

To start a review:

1. Click **Start a review** and describe what you want feedback on.
2. Under **Changes to review**, choose the branch containing the work. **My current saved code** means the currently checked-out Git commit (`HEAD`).
3. Under **Compare with**, choose the starting code, often your team's `main` branch. No starting branch is silently inferred.
4. Click **Create review**. Inspect **Code changes**, then use **Discuss these changes** to add feedback.
5. **Save feedback** saves on this computer. Use **Share & get updates** to exchange it with teammates.

Branch selectors include local and last-downloaded team branches, with an option to enter a branch name or commit ID manually. Help icons explain the choices on hover or keyboard focus. Only committed code is included, not unsaved or uncommitted working-file edits.

Open reviews have separate **Discussion** and **Code changes** views. The version selector shows **Version 1**, **Version 2**, etc.; comments carry the version they discuss. Full review/revision IDs and exact base/head commits remain available under **Git details & IDs**. These display numbers refer to the current ordered revision list; stored identities remain UUIDs.

Use **Add updated code** → **Save new version** after changing the code. Previous feedback and code versions remain available. The starting code defaults to the previous version's saved base. Adding versions, refreshing feedback, and sharing preserve the version being discussed and any draft. Use **View latest version** to switch explicitly; changing versions or reviews asks before discarding unsaved feedback. Returning to the review list keeps the current review draft and marks its card.

The left-hand navigation separates **Reviews** from **Change notes** (the previous **Commit notes** screen). **Which should I use?** explains when each is useful. Switching workspaces preserves drafts and selections within the open page; these drafts do not survive a page reload. On smaller screens, navigation sits above the content. Replies can cross review versions; the feedback form explicitly names the version that a new comment or reply will reference.

### Revision diff viewer

Select a review, choose a version, and open **Code changes** to see the read-only **What changed?** comparison. A short legend explains added and removed lines. The unified diff compares the exact retained base and head trees, not your working files or a newly computed merge base. Additions, deletions, and hunk headers are highlighted; binary changes appear as Git's binary-change markers. Renames currently appear as deletion/addition pairs. An empty comparison explains that both saved snapshots contain the same code.

Diffs are served through the authenticated `GET /api/reviews/:id/revisions/:revisionId/diff` endpoint. Repository external diff and text conversion helpers are disabled. Whitespace is preserved, and source text is rendered as text. Diffs over 2 MiB or 20,000 lines show an error with a local `git diff <base> <head>` fallback; they are not silently truncated. Inline commenting and side-by-side comparison are not implemented.

### Delete a local review

```powershell
git discuss review delete <review-id>
```

Deletion removes that review's local ref, including access to its snapshot history and discussions through the application. It uses the application lock and an expected-object-ID check. Other reviews, commit-linked notes, branches, and working files are unaffected. Code retained only by the deleted ref may eventually be garbage-collected. There is no application undo or remote deletion propagation.

### Notes on individual saved changes

The existing `comment` / `show` commands and browser **Change notes** workspace remain independent commit-linked discussions. They are not automatically imported into reviews; storage is still `refs/notes/git-discuss`.

In **Change notes**, **Where should we look?** lists local branches, last-downloaded team branches, and **My current saved code** (`HEAD`, including detached HEAD). The list leads with each change's description and author, with dates and short IDs as secondary details. Click a change to open its notes directly—there is no separate load step. The open change is highlighted. **Have a specific commit ID or branch?** exposes a manual input for Git users.

The picker loads 50 commits at a time. **Show older changes** continues from the same resolved tip, while **Refresh list** reloads branch choices and the selected branch's latest history. Remote-tracking branches reflect the last Git fetch; browsing does not fetch or check out branches. Opening a different change asks before discarding an unsaved note. Only ancestors of the selected ref are listed, so unrelated Git notes and review metadata histories are excluded.

## Sync discussions with teammates

Both developers use the same Git remote and run:

```powershell
# Fetch, reconcile, and push both Reviews and Commit notes
git discuss sync

# Optional: choose another configured remote or get machine-readable results
git discuss sync --remote upstream
git discuss sync --json
```

In the browser, click **Share & get updates** in **Share with your team**. The default connection is `origin`, or the first configured remote if `origin` is absent. Change it under **Sharing settings & help** → **Team repository**. That section explains what a Git remote is and offers setup guidance if no remote is configured.

The workspaces refresh after the operation while preserving drafts, the loaded commit, and the selected review version. Plain-language results lead with whether feedback was exchanged; **Exchange details** contains the ref counts. These describe storage refs downloaded, reconciled, uploaded, or unchanged—not individual comments. Posting still saves locally; sharing is an explicit action. The new-changes indicator tracks successful saves made in the current browser session, not a full repository-wide pending-sync audit. Draft text is never included in sharing.

Errors show a plain-language explanation with the original error available under **Technical details**. Setup commands and advanced Git IDs remain available without being required for everyday navigation.

For a new clone, run `git discuss sync` to download discussions that normal clone does not include. After posting comments or retaining revisions, sync again to share them. Your teammates do the same. Existing Git credentials are used; there is no application account or separate review service.

### Setup and scope

- A configured remote is required, normally `origin`. Check with `git remote -v`; if needed, add one with `git remote add origin <repository-url>`.
- The remote must permit custom refs and atomic Git pushes. Sync requires one matching fetch/push URL for the selected remote. Split URLs or multiple destinations need a separate, single-destination remote.
- Configure Git authentication beforehand using your usual credential manager or SSH agent. Sync disables terminal credential prompts and limits each network subprocess to two minutes. Authentication/network errors are displayed; configure access and retry.
- Sync transfers `refs/notes/git-discuss` and all `refs/git-discuss/reviews/*`, including code objects retained by those discussions. It does not move code branches, update remote-tracking code branches, check out files, or publish unrelated notes refs. Use normal Git commands to fetch/push branch tips.
- Deletions are **not** propagated. A review deleted only locally will be downloaded again if it exists on the remote; a ref deleted only remotely can be uploaded again from another clone. Shared deletion requires a future tombstone protocol.

### Reconciliation and failure handling

Sync holds the application write lock, fetches remote discussion refs into a unique temporary namespace, and validates every snapshot before updating local discussion refs. It combines immutable comment/revision records by ID. Identical records are deduplicated, and additions from both developers are retained. Existing sequence constraints preserve reply-before-child and revision history order; concurrent records are ordered deterministically by timestamp and UUID. Concurrent review revisions are both retained, not rebased or collapsed into one code change. Reviewers should explicitly select which revision they intend to discuss.

Different contents for the same record ID, changed review identity/title metadata, incompatible ordering, malformed history, or unsupported fields stop reconciliation with an explanation. Sync never selects one conflicting record silently. Resolve such a conflict with the other developer before retrying; there is no conflict-editing UI yet.

Successful reconciliation publishes all local refs in one compare-and-swap transaction, then uses an atomic, non-forced push. If upload fails (including another developer pushing concurrently), the reconciled work remains saved locally. Retry Sync to fetch the newer remote state, reconcile again, and upload. A server that cannot perform atomic pushes is reported as an error; there is no partial-push fallback. A network failure after server acceptance may leave the upload outcome uncertain; retrying is safe and deduplicates records.

Merge snapshots retain both input histories and referenced code. Sync also adds code-retention parent links to legacy note histories before upload, so newly synced notes can be read in another clone even if their code branch was never pushed. If an older manually transferred note refers to code missing from your clone, fetch its code branch first and retry. Temporary fetch refs are cleaned up after handled success/failure. A terminated process can leave temporary `refs/git-discuss/sync/*` refs and the application lock; these are not synchronized.

## Architecture

```text
src/cli.ts          Command-line entry point
src/core/           Review rules, validation, reconciliation, synchronization
src/git/            Git subprocesses and notes storage
src/server/         Local HTTP API and built UI hosting
src/web/            React workspaces, guided forms, sharing, and shared UI components
tests/              Git-backed integration and API tests
```

CLI / HTTP → review engine → Git storage. Browser assets are compiled by Vite and served by Fastify; end users run one server.

## Storage and boundaries

### Review storage

Each review is stored at `refs/git-discuss/reviews/<review-id>`. The ref points to a Git commit whose tree contains a validated `review.json` snapshot: version, stable ID, title, author, creation time, ordered revisions, and comments. Each revision has its own UUID, exact base/head object IDs, author, and creation time. Existing revision and comment records are never modified by application commands.

Every write creates a new snapshot commit. Its first parent is the previous snapshot when one exists. Creation and revision writes also link their base/head code commits as parents (duplicates removed). These links retain all reviewed commits and trees even after branches are rewritten or deleted and Git garbage collection runs. Comment-only writes retain code through their previous snapshot. Review snapshots are application metadata commits, not code commits to merge into a working branch.

Writers hold the repository-wide application lock and publish the snapshot with `git update-ref` using the expected previous object ID. A failed or interrupted write before publication leaves the previous snapshot intact; unpublished objects can be garbage-collected. Ordinary writes change one ref atomically; sync publishes its local ref updates together. Sync merge snapshots retain local and remote histories as parents. This remains a versioned snapshot format with conservative add-only reconciliation, not a general-purpose editable event protocol. There is currently no review editing, automatic commit-to-review notes index, or conversion of commit notes into reviews.

### Commit-linked notes

The original workflow attaches a JSON array of immutable comment records to an exact commit at `refs/notes/git-discuss`. Writes append a record under the same application lock, rewriting the note and retaining its previous version in notes history. Local-only notes do not guarantee retention of their annotated code after history rewriting. Sync snapshots add code-retention parent links before sharing notes. The note data is still readable with `git notes --ref=git-discuss show <commit>`.

### Boundaries

- Branch names resolve to exact commits. New commits, rebases, and squash merges do not automatically carry discussion forward.
- Inline comments, approvals, and summary generation are planned, not implemented.
- Normal clone/fetch/push does not automatically transfer these notes or review refs.
- Use `git discuss sync` to reconcile concurrent additions rather than force-pushing discussion refs.
- The lock coordinates this application's writers, not external `git notes` commands. A crashed writer may leave `git-discuss.lock` in the directory returned by `git rev-parse --git-common-dir`; remove it only after stopping writers.
- Git identity and timestamps are recorded metadata, not verified signatures.
- The server is scoped to one repository. It is not intended to be exposed as a network service.

Next milestones: richer sync status/conflict inspection and shared deletion semantics. Git notes can also become the commit-facing index and summary layer for stable reviews.

## Development checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:smoke
```

Rebuild and restart the server after changes. Tests create their own repositories in the system temporary directory.
