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
git discuss review comment <review-id> "Agreed." --reply-to <comment-id>
git discuss show --commit HEAD
```

Without linking, use `node dist/cli.js` instead of `git discuss`. The source CLI is available through `npm.cmd run cli -- --repo <path> show`; the UI server must run from the built distribution.

If Git reports that `discuss` is not a command, run `npm.cmd link` from this project directory, then check `git discuss --help`. Repository paths and branch names in the examples are placeholders: use branches that exist in the repository you are reviewing.

## Included

- Shared review engine used by the CLI and HTTP API
- Stable UUID review identities and append-only revisions with retained base/head commits
- Review-wide threaded discussions with explicit revision context
- Readable CLI review lists, unambiguous short IDs, latest-revision comments, and local review deletion
- Web editing of review titles, review replies, and flat commit notes; syncable deletion with retained history
- Read-only unified diffs of retained review revisions in the browser
- One-command / one-click sync of reviews and commit notes with a configured Git remote
- Optional receive-only background checks with draft-safe update notifications
- Add-only reconciliation of concurrent comments and revisions, with atomic publication
- Commit selection, flat plain-text notes, refresh, and error handling
- Git author identity, UTC timestamps, UUID comment IDs, and schema validation
- Persistent notes at `refs/notes/git-discuss`
- Repository-scoped write lock shared by application instances and linked worktrees
- Loopback server with launch token, Host/Origin checks, and same-origin UI
- Integration tests against real temporary Git repositories

CLI comment commands and the browser's **Save locally** action save on this computer without pushing. The browser also offers **Save & share now**, which saves first and then runs discussion sync. Neither action stages files, alters code commits, or creates application commits in your working branch. Git notes have their own history. The project directory itself does not need to be initialized as a Git repository to run the application against another repository.

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

The browser opens in **Reviews**, with a compact review list and a **Start a review** button. You can find a review by title or author, see its version/comment counts, and open it without entering any IDs. The first-use screen explains the three steps: choose changes, leave feedback, and share with the team.

The interface uses a simple GitHub pull-request-inspired layout: light or dark colors, project navigation, a prominent review title, underlined **Discussion** / **Code changes** controls, and bordered comment threads. On desktop, one right-hand sidebar holds **Share with your team**, sharing settings, update status, and the selected review's version/Git details. On smaller screens, the sidebar appears below the main content. Links such as **Go to sharing** take you directly to it. The green **Review** label identifies the type of discussion, not an approval or merge status.

Use the **Light / Dark** button in the header to switch appearance. The first visit uses your system preference; choosing a mode saves it in browser storage for that server address. A different launch port has separate browser storage (use a fixed `--port` if you want the same address across launches). Switching themes keeps your drafts and selections. If browser storage is blocked, the toggle still works for the current page.

To start a review:

1. Click **Start a review** and describe what you want feedback on.
2. Under **Changes to review**, choose the branch containing the work. **My current saved code** means the currently checked-out Git commit (`HEAD`).
3. Under **Compare with**, choose the starting code, often your team's `main` branch. No starting branch is silently inferred.
4. Click **Create review**. Inspect **Code changes**, then use **Discuss these changes** to add feedback.
5. Choose **Save locally** to share later, or **Save & share now** to immediately exchange saved feedback with teammates.

Branch selectors include local and last-downloaded team branches, with an option to enter a branch name or commit ID manually. Help icons explain the choices on hover or keyboard focus. Only committed code is included, not unsaved or uncommitted working-file edits.

Open reviews have separate **Discussion** and **Code changes** views. The version selector shows **Version 1**, **Version 2**, etc.; comments carry the version they discuss. Full review/revision IDs and exact base/head commits remain available under **Git details & IDs**. These display numbers refer to the current ordered revision list; stored identities remain UUIDs.

Use **Add updated code** → **Save new version** after changing the code. Previous feedback and code versions remain available. The starting code defaults to the previous version's saved base. Adding versions, refreshing feedback, and sharing preserve the version being discussed and any draft. Use **View latest version** to switch explicitly; changing versions or reviews asks before discarding unsaved feedback. Returning to the review list keeps the current review draft and marks its card.

Project navigation separates **Reviews** from **Change notes** (the previous **Commit notes** screen). **Which should I use?** explains when each is useful. Switching workspaces preserves drafts and selections within the open page; these drafts do not survive a page reload. Replies can cross review versions; the feedback form explicitly names the version that a new comment or reply will reference.

### Revision diff viewer

Select a review, choose a version, and open **Code changes** to see the read-only **What changed?** comparison. A short legend explains added and removed lines. The unified diff compares the exact retained base and head trees, not your working files or a newly computed merge base. Additions, deletions, and hunk headers are highlighted; binary changes appear as Git's binary-change markers. Renames currently appear as deletion/addition pairs. An empty comparison explains that both saved snapshots contain the same code.

Diffs are served through the authenticated `GET /api/reviews/:id/revisions/:revisionId/diff` endpoint. Repository external diff and text conversion helpers are disabled. Whitespace is preserved, and source text is rendered as text. Diffs over 2 MiB or 20,000 lines show an error with a local `git diff <base> <head>` fallback; they are not silently truncated. Inline commenting and side-by-side comparison are not implemented.

### Edit or delete in the browser

- Open a review and choose **Edit title**, then **Save title**. **Title history** in the sidebar shows earlier titles.
- In **Reviews**, comments and replies have **Edit** and **Delete** actions. In **Change notes**, each note is a single entry (no replies) with the same edit/delete history controls.
- Deleting a review comment asks for confirmation, replaces its text with **This comment was deleted**, and keeps replies in place. In **Change notes**, deleting a note does not affect other notes on that commit.
- **Delete review** asks for confirmation and removes the review from the list, including access to its discussion through normal navigation. Its retained deletion record is shared with the team on the next **Share & get updates**, so an older copy cannot bring it back.

Changes save locally first and record the current Git author and timestamp. The local launch session can manage the repository's discussions; Git author metadata is not an ownership permission check. Saves include the version of the item that was opened, so a stale editor cannot silently overwrite an edit that has already arrived locally. If this check fails, the inline draft stays available: copy it if needed, cancel the edit, refresh the discussion, and reopen Edit using the current text.

Deletion is a retained marker, not secure erasure. Original text, edit history, review replies, review revisions, and referenced code remain in Git. There is no restore/undelete action yet. Draft feedback on an externally deleted review is shown for copying when that deletion is received.

Edited/deleted records use schema version 2 with an append-only `changes` array. Existing version-1 discussions remain readable without migration. All teammates should update the application before sharing edits or deletions: older clients reject version-2 records rather than silently dropping this history. Raw JSON output (`review show`, `show`, or `git notes`) contains original text plus change records; the web UI displays the effective text, and `review list` shows the effective title.

### Remove a review only from this clone (CLI)

```powershell
git discuss review delete <review-id>
```

This existing CLI command removes the local review ref rather than recording the web UI's shared deletion marker. It uses the application lock and an expected-object-ID check. Other reviews, commit-linked notes, branches, and working files are unaffected. Code retained only by the removed ref may eventually be garbage-collected. The remote copy can be fetched again on sync. Use **Delete review** in the browser when you want the deletion shared with the team.

### Notes on individual saved changes

The existing `comment` / `show` commands and browser **Change notes** workspace remain independent commit-linked discussions. They are not automatically imported into reviews; storage is still `refs/notes/git-discuss`.

In **Change notes**, **Where should we look?** lists local branches, last-downloaded team branches, and **My current saved code** (`HEAD`, including detached HEAD). The list leads with each change's description and author, with dates and short IDs as secondary details. Click a change to open its notes directly—there is no separate load step. The open change is highlighted. **Have a specific commit ID or branch?** exposes a manual input for Git users.

Each saved change shows its note count, including non-deleted notes and excluding deleted notes. Counts update when you save or delete a note, refresh, share updates, or receive background updates, without resetting the chosen branch or older loaded pages. Review discussions are separate and are not included in these counts. If a stored note cannot be read, its count is shown as **Notes unavailable** rather than zero.

The picker loads 50 commits at a time. **Show older changes** continues from the same resolved tip, while **Refresh list** reloads branch choices and the selected branch's latest history. Remote-tracking branches reflect the last Git fetch; browsing does not fetch or check out branches. Opening a different change asks before discarding an unsaved note. Only ancestors of the selected ref are listed, so unrelated Git notes and review metadata histories are excluded.

### Save now, share now or later

In **Reviews**, comment/reply forms and, in **Change notes**, note forms offer two actions:

- **Save locally** stores the feedback in Git on this computer. Later, use **Share & get updates** in the sharing sidebar to submit your saved work together.
- **Save & share now** saves the current feedback entry, then runs the existing sync action using the **Team repository** selected in Sharing settings. This also shares **all other locally saved review discussions and change notes**, not just the new entry. It is disabled until a team repository is available.

Locally saved comments are not a private pending-review batch: any later share includes them. Unsubmitted text still in a text area is a draft and is never uploaded. Submitting a form without selecting the share action defaults to saving locally.

Saving and sharing are separately acknowledged. Once saving succeeds, the submitted text is cleared and the comment appears locally. If the subsequent sync fails, the UI says **Your comment was saved locally, but sharing was not confirmed** and directs you to retry **Share & get updates**—without posting the comment again. If the save request fails, the draft remains and no sync is started.

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

The workspaces refresh after the operation while preserving new-comment drafts, the loaded commit, and the selected review version. When an inline comment edit, title edit, or version form is open, display refresh is deferred until you finish or cancel it and choose **Show updates**. Plain-language results lead with whether feedback was exchanged; **Exchange details** contains the ref counts. These describe storage refs downloaded, reconciled, uploaded, or unchanged—not individual comments. Posting still saves locally; sharing is an explicit action. The new-changes indicator tracks successful saves made in the current browser session, not a full repository-wide pending-sync audit. Draft text is never included in sharing.

Errors show a plain-language explanation with the original error available under **Technical details**. Setup commands and advanced Git IDs remain available without being required for everyday navigation.

For a new clone, run `git discuss sync` to download discussions that normal clone does not include. After posting comments or retaining revisions, sync again to share them. Your teammates do the same. Existing Git credentials are used; there is no application account or separate review service.

### Automatic background updates

In **Sharing settings & help**, select your team repository and enable **Check for team updates automatically**. Checks start immediately, then run once per minute after the preceding check finishes. **Check now** runs a receive-only check sooner. Checks never overlap.

The local server fetches discussion refs and reconciles incoming notes, reviews, edits, and deletions into local storage. This operation **never pushes**, even when you have unpublished local feedback. It does not change code branches, working files, or remote-tracking code branches. Uploads remain explicit through **Share & get updates** or a comment form's **Save & share now**.

The browser checks the server's lightweight update status every five seconds. New local discussion data produces a **New feedback available → Show updates** notice. The active discussion and review list stay as loaded until you choose to show updates; commit note counts can refresh quietly. Your draft, selected commit/version, and expanded discussion details stay in place. The notice only occupies space when updates are available; no blank placeholder is reserved. Inline edit/title/version forms defer refresh until finished or canceled, including when another user edits or deletes the same content. A deleted review still offers its unsaved new-comment draft for copying when you apply the update.

Network and reconciliation failures appear as a quiet **Updates paused — will retry** status, with optional details. Retries back off to a maximum of five minutes; you can also choose **Check now**. A conflict leaves local discussion refs unchanged. New comments can still be drafted, and foreground saves/sharing pause or cancel the server's current background check before writing.

Background fetching and reconciliation run outside the application write lock. Publication uses a short locked atomic compare-and-swap transaction. If a CLI or another application instance changes a discussion while a background check is preparing, publication is rejected and a later check starts from the newer local data. Temporary receive refs under `refs/git-discuss/background/*` are cleaned up after handled success/failure.

The setting is **off by default**, shared by browser tabs connected to this server, and lasts for the current server session. Closing a browser tab does not stop an enabled server-side worker. Disable the setting to stop it; stopping `git discuss serve` cancels active background network requests and clears its timer. Restarting the server starts with automatic checks off. This is a local-server feature, not an operating-system background service.

Authenticated API endpoints: `GET /api/background-updates` for status, `POST /api/background-updates` with `{ "enabled": true, "remote": "origin" }` to configure, and `POST /api/background-updates/check` to request an immediate check while enabled. These endpoints never invoke the push-capable sync operation.

### Setup and scope

- A configured remote is required, normally `origin`. Check with `git remote -v`; if needed, add one with `git remote add origin <repository-url>`.
- The remote must permit custom refs and atomic Git pushes. Sync requires one matching fetch/push URL for the selected remote. Split URLs or multiple destinations need a separate, single-destination remote.
- Configure Git authentication beforehand using your usual credential manager or SSH agent. Sync disables terminal credential prompts and limits each network subprocess to two minutes. Authentication/network errors are displayed; configure access and retry.
- Sync transfers `refs/notes/git-discuss` and all `refs/git-discuss/reviews/*`, including code objects retained by those discussions. It does not move code branches, update remote-tracking code branches, check out files, or publish unrelated notes refs. Use normal Git commands to fetch/push branch tips.
- Web edits and deletion markers are propagated. Removing a ref directly (or using the existing local-only CLI delete command) is not a shared deletion; another clone can supply that ref again. Web-deleted reviews remain hidden after syncing with older snapshots.

### Reconciliation and failure handling

Explicit Sync holds the application write lock, fetches remote discussion refs into a unique temporary namespace, and validates every snapshot before updating local discussion refs. Background receive uses the shorter publication-only lock described above. Both combine immutable comment/revision records and their append-only change histories by ID. Identical records are deduplicated, and additions from both developers are retained. Existing sequence constraints preserve parent-before-reply and revision history order; concurrent records are ordered deterministically by timestamp and UUID. Concurrent review revisions are both retained, not rebased or collapsed into one code change. Reviewers should explicitly select which revision they intend to discuss.

Concurrent edits to the same comment or review title are both retained in its history; the final edit in the deterministic merged order is displayed. This is a consistent ordering, not a guarantee that unsynchronized clocks identify the actual last human edit. Deletion takes precedence over edits regardless of their order. A review deleted while a teammate adds feedback stays deleted, with that feedback retained in its stored history.

Different contents for the same immutable record or change ID, changes to original review identity/title metadata outside the supported edit history, incompatible ordering, malformed history, or unsupported fields stop reconciliation with an explanation. Sync never selects one conflicting immutable record silently. Resolve such a conflict with the other developer before retrying; there is no raw-history conflict-editing UI yet.

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

Writers hold the repository-wide application lock and publish the snapshot with `git update-ref` using the expected previous object ID. A failed or interrupted write before publication leaves the previous snapshot intact; unpublished objects can be garbage-collected. Ordinary writes change one ref atomically; sync publishes its local ref updates together. Sync merge snapshots retain local and remote histories as parents. Edits and web deletions append change records without rewriting original records; deleted review refs are retained to preserve the deletion and reviewed code. There is currently no automatic commit-to-review notes index or conversion of commit notes into reviews.

### Commit-linked notes

The original workflow attaches a JSON array of comment records to an exact commit at `refs/notes/git-discuss`. Writes append comments or append edit/deletion records to a comment's `changes` history under the same application lock, rewriting the note and retaining its previous version in notes history. Original comment fields remain immutable. Local-only notes do not guarantee retention of their annotated code after history rewriting. Sync snapshots add code-retention parent links before sharing notes. The raw note data is still readable with `git notes --ref=git-discuss show <commit>`.

### Boundaries

- Branch names resolve to exact commits. New commits, rebases, and squash merges do not automatically carry discussion forward.
- Inline comments, approvals, and summary generation are planned, not implemented.
- Normal clone/fetch/push does not automatically transfer these notes or review refs.
- Use `git discuss sync` to reconcile concurrent additions rather than force-pushing discussion refs.
- The lock coordinates this application's writers, not external `git notes` commands. A crashed writer may leave `git-discuss.lock` in the directory returned by `git rev-parse --git-common-dir`; remove it only after stopping writers.
- Git identity and timestamps are recorded metadata, not verified signatures.
- The server is scoped to one repository. It is not intended to be exposed as a network service.

Next milestones: richer sync status/conflict inspection and explicit restore workflows. Git notes can also become the commit-facing index and summary layer for stable reviews.

## Development checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:smoke
```

Rebuild and restart the server after changes. Tests create their own repositories in the system temporary directory.
