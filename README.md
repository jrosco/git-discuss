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

## Desktop app

The desktop version adds a system-tray menu for opening Git Discuss, choosing repositories, switching between running repositories, and quitting. Multiple different repositories can stay open at once, with one local server per repository; reopening a running repository reuses its server. Use **Running repositories** to open one in the browser and **Close repository** to stop an individual server. The last-used repository starts automatically on launch; other recent repositories are available on demand. All servers stop when you quit, while up to eight repository paths are remembered. The web interface continues to open in your default browser.

```powershell
# Run the desktop app from this checkout
npm.cmd run desktop:dev

# Create an unpacked desktop app for the current platform
npm.cmd run desktop:pack

# Create platform installer(s) for the current build host
npm.cmd run desktop:dist
```

Desktop packages target Windows (NSIS installer), macOS (DMG), and Linux (AppImage and DEB). Build each platform's installer on that platform, or use a CI build matrix. Git must be installed and available on `PATH`; end users do not need to install Node.js separately.

```powershell
# Optional: register the git-discuss executable on your PATH
npm.cmd link

# Run inside a repository, or supply --repo
git discuss serve
git discuss serve --commit main --port 43821 --no-open
git discuss comment "Could we simplify this?" --commit HEAD
git discuss comment "More context for this commit." --commit HEAD --append
git discuss review comment <review-id> "Agreed." --reply-to <comment-id>
git discuss show --commit HEAD
```

Without linking, use `node dist/cli.js` instead of `git discuss`. The source CLI is available through `npm.cmd run cli -- --repo <path> show`; the UI server must run from the built distribution.

If Git reports that `discuss` is not a command, run `npm.cmd link` from this project directory, then check `git discuss --help`. Repository paths and branch names in the examples are placeholders: use branches that exist in the repository you are reviewing.

## Included

- Shared review engine used by the CLI and HTTP API
- Stable review identities that follow pushed branch commits while retaining historical comparisons
- Review-wide threaded discussions pinned to exact code commits
- Commit-to-code links and syncable resolved/reopened review threads
- Readable CLI review lists, short IDs, commit-pinned comments, and local review deletion
- Web editing of review titles, review replies, and flat commit notes; syncable deletion with retained history
- Read-only unified diffs of retained review revisions in the browser
- One-command / one-click sync of reviews and commit notes with a configured Git remote
- Optional receive-only background checks with draft-safe update notifications
- Add-only review reconciliation and three-way plain-note reconciliation, with atomic publication
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
# Defaults to the review's current observed code and prints the exact commit used
git discuss review comment <review-id> "Why invalidate here?"
# Discuss an earlier saved commit explicitly
git discuss review comment <review-id> "About this code" --commit <commit-sha>

# After committing changes, push code using Git and check for team updates
git push origin feature/cache
git discuss sync
git discuss review comment <review-id> "Updated the approach." --reply-to <comment-id>

# Connect an older, fixed review to a branch once
git discuss review follow <review-id> --head feature/cache
```

New browser and CLI reviews follow the branch selected as their head. `HEAD` follows the currently checked-out branch when attached; a commit SHA, tag, or detached HEAD creates a fixed comparison. Use `review create ... --pinned` to keep an exact comparison even when supplying a branch. The starting base is captured explicitly and remains fixed; it is not recomputed as a merge base when source code advances.

`review list` shows review ID, current commit, retained commit count, comment count, and title. `review list --json` and `review show` include the saved comparisons and locally observed current comparison. Internal `revisions` and their UUIDs remain for precise base/head history and old comment links, but normal interaction uses commit IDs. `review revise` remains an advanced command for pinned reviews only; tracked reviews receive code updates through sync/checks.

All review commands accept an unambiguous review ID prefix of at least four characters. Review comments also accept revision and reply-target prefixes. The list displays eight-character prefixes, lengthened when necessary to distinguish IDs. Ambiguous prefixes fail with matching full IDs so you can supply more characters. Full UUIDs still work.

For example, if `review list` shows review `78db5a4d`:

```powershell
git discuss review show 78db5a4d
git discuss review comment 78db5a4d "Looks good"
git discuss review comment 78db5a4d "About the older code" --commit abc1234
```

The review ID is positional. Comments default to the review's current observed code while holding the write lock. `--commit` selects a retained head commit; `--revision` remains an advanced comparison-ID selector, useful if a historical commit has multiple different bases. Supply only one of those selectors. Posting prints the exact comparison ID and head used, including when replying to a comment on older code.

### Using the browser

The browser opens in **Reviews**, with a compact review list and a **Start a review** button. You can find a review by title or author, see its tracked branch/current commit and comment count, and open it without entering IDs. The first-use screen explains the three steps: choose changes, leave feedback, and share with the team.

The interface uses a simple GitHub pull-request-inspired layout: light or dark colors, project navigation, a prominent review title, underlined **Discussion** / **Code changes** controls, and bordered comment threads. On desktop, one right-hand sidebar holds **Share with your team**, sharing settings, update status, and the selected review's branch/code history. On smaller screens, the sidebar appears below the main content. Links such as **Go to sharing** take you directly to it. The green **Review** label identifies the type of discussion, not an approval or merge status.

Use the **Light / Dark** button in the header to switch appearance. The first visit uses your system preference; choosing a mode saves it in browser storage for that server address. A different launch port has separate browser storage (use a fixed `--port` if you want the same address across launches). Switching themes keeps your drafts and selections. If browser storage is blocked, the toggle still works for the current page.

To start a review:

1. Click **Start a review** and describe what you want feedback on.
2. Under **Changes to review**, choose the branch containing the work. **My current saved code** means the currently checked-out Git commit (`HEAD`).
3. Under **Compare with**, choose the starting code, often your team's `main` branch. No starting branch is silently inferred.
4. Click **Create review**. Inspect **Code changes**, then use **Discuss these changes** to add feedback.
5. Choose **Save locally** to share later, or **Save & share now** to immediately exchange saved feedback with teammates.

**Changes to review** and **Compare with** use searchable dropdowns with a **Current selection** header, a **Current** badge, keyboard navigation, and **Show older results**. They include local and last-downloaded team branches. To enter a branch name or commit ID, type it and press Enter or choose its **Use** entry. An unfinished search cannot silently use the previous selection. Escape restores the selected value. Only committed code is included, not unsaved working-file edits.

Open reviews have **Discussion** and **Code changes** views. **Code history** shows retained commits by short SHA and commit subject, with the current observed code first. There is no manual **Add updated code** step. After the author commits and pushes, background checks, **Check latest code**, or **Share & get updates** retain the new comparison in the same review. Enable automatic updates in Sharing settings for periodic checks; **Check latest code** is receive-only and also works when periodic checks are off.

When you show incoming updates, an idle view of the previously current commit moves to the newly received commit automatically. Drafts remain pinned to the commit they started on, and an intentionally selected historical comparison remains selected. **View latest code** switches explicitly when you're ready. Opening a review fresh selects its current observed commit.

Click **Commit abc123 ↗** on a comment or reply to open its original saved comparison. Older comments are never re-anchored to newer code. Moving to different code asks before discarding an unsaved new-comment draft. Links and selectors never check out branches or change working files. Full review/comparison IDs and base/head SHAs remain under **Git details & IDs**.

### Which branch is followed?

A local branch follows the same `refs/heads/<name>` on the team remote selected for sharing/receiving. Its Git upstream is not substituted: a feature branch can have `main` as its upstream. Choosing a remote-tracking branch follows its corresponding published branch name on the selected team repository. If local and published names differ, choose the team branch explicitly. Remote aliases such as `origin` stay local to each clone.

The review retains its initial code if the remote still has the known older tip and the author's new code has not been pushed. Once a new pushed tip is observed, later rebases and backward moves are followed as well. Repeated observations reuse existing comparisons. A missing/deleted source branch keeps the last saved code and displays a message; restoring/pushing that branch resumes tracking. Branch renames are not inferred automatically.

Existing reviews remain fixed until you choose **Follow a branch** once (or run `review follow`). Their original comments and comparisons stay intact. Tracking uses the existing comparison's base and the chosen branch's current local code as its initial snapshot. Once connected, the source branch and baseline are stable review metadata; changing to a different source/baseline requires another review.

### Resolve individual discussion threads

The first comment in each review thread has **Resolve thread** / **Reopen thread** controls. Resolution applies to that comment and all its replies, including replies referring to other commits. Other threads remain independent, and the discussion header shows open and resolved counts across all retained code.

Resolved threads are collapsed with a **Resolved** badge, the resolving person's Git identity, and a timestamp. **Show discussion** lets you read them without reopening. The commit link stays available while collapsed. **Resolution history** retains explicit resolve/reopen actions. Even a deleted parent comment can have its surviving discussion resolved.

Reopen a resolved thread before posting a new reply. Existing comment edits remain available; changing thread content makes it open again. If an offline reply, edit, or deletion arrives after a resolution, the thread also becomes open so new feedback is not hidden as completed. The original resolution remains in history. Receiving another code commit alone does not reopen a thread whose feedback has not changed.

Resolve/reopen operations are saved locally first and included in **Share & get updates**. Each resolution records the exact comment-content versions it covers. A stale action is rejected if the thread changed after it was loaded. The UI blocks resolution while an inline edit or unsaved reply for that thread is open; drafts are retained if someone else resolves it. Thread resolution is separate from approving or completing the whole review.

Resolution records add `resolve` and `reopen` change kinds to version-2 review comments. Teammates need the updated application to read and reconcile these records; older versions reject unknown change kinds rather than silently dropping them.

Returning to the review list keeps the current draft and marks its card. Changing code comparisons or reviews asks before discarding unsaved feedback.

Project navigation separates **Reviews** from **Change notes**. **Which should I use?** explains when each is useful. The workspace is remembered in browser-tab session storage. Switching workspaces preserves drafts and selections within the open page; drafts do not survive a page reload. Replies can refer to different commits; the feedback form names the commit that a new comment or reply will reference.

### Revision diff viewer

Select a retained commit in **Code history**, then open **Code changes** for the read-only **What changed?** comparison. The diff uses that comparison's exact retained base and head, not working files or a newly computed merge base. Additions, deletions, and hunk headers are highlighted; binary changes appear as Git's markers. Renames appear as deletion/addition pairs. Empty comparisons explain that both snapshots contain the same code.

Diffs are served through the authenticated `GET /api/reviews/:id/revisions/:revisionId/diff` endpoint. Repository external diff and text conversion helpers are disabled. Whitespace is preserved, and source text is rendered as text. Diffs over 2 MiB or 20,000 lines show an error with a local `git diff <base> <head>` fallback; they are not silently truncated. Inline commenting and side-by-side comparison are not implemented.

### Edit or delete in the browser

- Open a review and choose **Edit title**, then **Save title**. **Title history** in the sidebar shows earlier titles.
- In **Reviews**, comments and replies have **Edit**, **Delete**, and **View history** actions. In **Change notes**, each commit has one plain-text/Markdown note with **Add note**, **Edit**, **Append**, and **Delete** actions. **Cancel editing** keeps the stored note unchanged.
- Deleting a review comment asks for confirmation, replaces its text with **This comment was deleted**, and keeps replies in place. Deleting a commit note removes that commit's entire note; notes on other commits are unaffected. Previous note text remains in the Git notes ref's commit history.
- **Delete review** asks for confirmation and removes the review from the list, including access to its discussion through normal navigation. Its retained deletion record is shared with the team on the next **Share & get updates**, so an older copy cannot bring it back.

Changes save locally first and record the current Git author and timestamp. The local launch session can manage the repository's discussions; Git author metadata is not an ownership permission check. Saves include the version of the item that was opened, so a stale editor cannot silently overwrite an edit that has already arrived locally. If this check fails, the inline draft stays available: copy it if needed, cancel the edit, refresh the discussion, and reopen Edit using the current text.

Review deletion uses a retained marker. Plain commit-note deletion removes the note from the current notes tree and is reconciled using Git history. Neither is secure erasure: previous text remains in Git history. There is no restore/undelete UI yet. Draft feedback on an externally deleted review is shown for copying when that deletion is received.

Tracked reviews use schema version 3; older pinned reviews use versions 1/2. Edits/deletions retain their append-only `changes` history, and edits to tracked reviews preserve schema 3. `review show` contains original text plus change records and locally observed current-code information. Commit notes remain plain text; `show` returns the text in `note` and its blob ID in `noteVersion`. Older structured commit-note JSON remains verbatim note text. Collaborators need the updated application to read tracked reviews; older clients reject the new schema rather than dropping tracking data.

### Remove a review only from this clone (CLI)

```powershell
git discuss review delete <review-id>
```

This existing CLI command removes the local review ref rather than recording the web UI's shared deletion marker. It uses the application lock and an expected-object-ID check. Other reviews, commit-linked notes, branches, and working files are unaffected. Code retained only by the removed ref may eventually be garbage-collected. The remote copy can be fetched again on sync. Use **Delete review** in the browser when you want the deletion shared with the team.

### Notes on individual saved changes

The existing `comment` / `show` commands and browser **Change notes** workspace remain independent commit-linked discussions. They are not automatically imported into reviews; storage is still `refs/notes/git-discuss`.

In **Change notes**, **Where should we look?** searches local branches, last-downloaded team branches, and **My current saved code** (`HEAD`, including detached HEAD). The **Commit ID or branch name** picker uses the same dropdown style, with a readable selected value, a **Current selection** header, a **Current** badge, and incremental **Show older results**. Clicking the selected value shows the available list rather than filtering down to that one commit. Type to search subjects, authors, IDs, or branch names. Choose a suggestion to open it, or enter a ref and use **Open notes**. Both pickers support arrow keys, Enter, and Escape, and can be reopened by clicking even when already focused.

Each commit can have one plain-text note in `refs/notes/git-discuss`. Suggestions with nonblank note text show a note icon. **Show only commits with notes** filters the currently loaded history; use **Show older results** to search further back. Note presence updates after saves, deletes, refreshes, sharing, and background receipt. Review discussions are separate and are not included.

The picker fetches 50 commits at a time and reveals results in smaller groups. **Show older results** first reveals more loaded matches, then fetches an older page from the same resolved tip when needed. **Refresh list** reloads branch choices and the selected branch's latest history. Remote-tracking branches reflect the last Git fetch; browsing does not fetch or check out branches. Opening a change, including reopening the current one, asks before discarding an unsaved note. Refreshing or sharing defers display updates while a note form is open. Only ancestors of the selected ref are listed, so unrelated Git notes and review metadata histories are excluded.

Notes are saved verbatim, including Markdown indentation and trailing spaces. The complete note is limited to 100,000 characters, including appended text. Review comments remain limited to 20,000 characters. The editor's formatting buttons obey these limits. A save returns the stored note and its version in the same response; the browser does not need a second request to acknowledge the save. API note edits/deletes must supply `expectedVersion` from the loaded conversation, and stale replacements are rejected. `git discuss comment` creates a note and refuses to overwrite an existing one; use `--append` to add text.

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

Workspaces refresh after sharing. A tracked review's current-code view follows newly received code when there is no draft; drafts and deliberately selected historical comparisons keep their original commit context. Inline comment edits, title edits, and branch-connection forms defer display refresh until finished or canceled. **Exchange details** counts discussion storage refs, not comments or code branches. Posting still saves locally; uploading feedback is explicit. The new-changes indicator tracks saves made in the current browser session, not a full repository-wide pending-sync audit. Draft text is never uploaded.

Errors show a plain-language explanation with the original error available under **Technical details**. Setup commands and advanced Git IDs remain available without being required for everyday navigation.

For a new clone, run `git discuss sync` to download discussions that normal clone does not include. After posting comments or retaining revisions, sync again to share them. Your teammates do the same. Existing Git credentials are used; there is no application account or separate review service.

### Automatic background updates

In **Sharing settings & help**, select your team repository and enable **Check for team updates automatically**. Checks start immediately, then run once per minute after the preceding check finishes. **Check now** runs a receive-only check sooner. Checks never overlap.

The local server fetches discussion refs **and the source branches of active tracked reviews**, reconciling feedback and retaining newly observed code comparisons. It **never pushes**, even when you have unpublished local feedback. Code branches are fetched into temporary application refs; checked-out branches, working files, and normal remote-tracking branches are unchanged. Use normal Git tools to commit and push code. Uploading discussions remains explicit through **Share & get updates** or **Save & share now**.

The browser checks update status every five seconds. Incoming tracked code or review feedback produces **New code or feedback available → Show updates**. Content stays as loaded until you choose to show updates; note counts can refresh quietly. Without a draft, a view of the current code advances to the newly received commit. A draft or a historical comparison stays pinned to its original commit. The notice takes no space when there are no updates. Inline edit/title/branch-connection forms defer refresh until finished or canceled. A deleted review still offers its unsaved new-comment draft for copying.

The notice identifies the most recent received batch: which workspace changed, how many reviews changed, and up to five review IDs / commit IDs, with explicit **Open** links. **Show updates** keeps the current review or commit-note selection; tracked review code advances under the draft-safe rules above. Other reviews or commit notes are opened only through explicit navigation. The latest summary is kept when automatic checks are disabled, and identifies the remote it came from. It is a summary of the latest batch, not an exhaustive change-by-change audit across every unseen check. Ref-history-only changes without new note/review content do not generate a feedback notification.

Network and reconciliation failures appear as a quiet **Updates paused — will retry** status, with optional details. Retries back off to a maximum of five minutes; you can also choose **Check now**. A conflict leaves local discussion refs unchanged. New comments can still be drafted, and foreground saves/sharing pause or cancel the server's current background check before writing.

Background fetching and reconciliation run outside the application write lock. Publication uses a short locked atomic compare-and-swap transaction. If a CLI or another application instance changes a discussion while a background check is preparing, publication is rejected and a later check starts from the newer local data. Temporary receive refs under `refs/git-discuss/background/*` are cleaned up after handled success/failure.

The setting is **off by default**, shared by browser tabs connected to this server, and lasts for the current server session. Closing a browser tab does not stop an enabled server-side worker. Disable the setting to stop it; stopping `git discuss serve` cancels active background network requests and clears its timer. Restarting the server starts with automatic checks off. This is a local-server feature, not an operating-system background service.

Authenticated API endpoints: `GET /api/background-updates` for status, `POST /api/background-updates` with `{ "enabled": true, "remote": "origin" }` to configure, and `POST /api/background-updates/check` to request an immediate check while enabled. These endpoints never invoke the push-capable sync operation.

`POST /api/receive` with `{ "remote": "origin" }` performs a foreground, receive-only check even if automatic updates are disabled. The review's **Check latest code** button uses it. `POST /api/reviews/:id/tracking` with `{ "head": "feature/login" }` connects an existing pinned review. API creation supports `followBranch: true` (and an optional local `trackingRemote` hint for the initial cached remote tip); omission preserves pinned behavior for older API clients. CLI and browser creation opt into following by default. Review API responses include `currentRevisionId` and local `trackingStatus`, separate from stored shared metadata.

### Setup and scope

- A configured remote is required, normally `origin`. Check with `git remote -v`; if needed, add one with `git remote add origin <repository-url>`.
- The remote must permit custom refs and atomic Git pushes. Sync requires one matching fetch/push URL for the selected remote. Split URLs or multiple destinations need a separate, single-destination remote.
- Configure Git authentication beforehand using your usual credential manager or SSH agent. Sync disables terminal credential prompts and limits each network subprocess to two minutes. Authentication/network errors are displayed; configure access and retry.
- Sync transfers `refs/notes/git-discuss` and `refs/git-discuss/reviews/*`, including retained code objects. It also fetches named source branches into temporary refs for tracked reviews. It does not publish branch tips, update normal remote-tracking branches, check out files, or publish private tracking state. Use normal Git commands to push code.
- Web edits and deletion markers are propagated. Removing a ref directly (or using the existing local-only CLI delete command) is not a shared deletion; another clone can supply that ref again. Web-deleted reviews remain hidden after syncing with older snapshots.

### Reconciliation and failure handling

Explicit Sync holds the application lock while reconciling and publishing; background receive prepares outside that lock and publishes with guarded atomic ref updates. Review comments and their edit histories combine by immutable ID, preserving parent-before-reply order. Tracked comparisons merge as a deduplicated set so different observers can see commits in different orders after a rebase or rewind. Automatically retained comparisons use deterministic UUIDs derived from the review ID and exact base/head pair, with metadata from the code commit. Two developers observing the same push produce the same record. Pinned legacy comparisons retain their existing ordering rules.

Plain notes are reconciled **per annotated commit**, using their common notes history. Independent notes on different commits and one-sided edits/deletions are retained. Independent appends to the same existing text retain both suffixes in deterministic order. Conflicting replacements, or an edit racing with deletion of the same note, stop synchronization before publishing any local discussion ref; neither side is silently preferred. Git commit times are not used to guess a winner.

To resolve a conflicting plain note using Git, stop the local application server, fetch the remote notes into a separate ref, and use Git's manual notes merge:

```powershell
git fetch origin refs/notes/git-discuss:refs/notes/git-discuss-incoming
git notes --ref=git-discuss merge -s manual refs/notes/git-discuss-incoming
# If Git reports a conflict, edit the files in the NOTES_MERGE_WORKTREE path it prints.
git notes --ref=git-discuss merge --commit
git discuss sync
```

The merge records both histories so the chosen resolution is recognized on subsequent sync. The application does not provide a raw-note conflict editor yet.

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

Each review is stored at `refs/git-discuss/reviews/<review-id>`. Its commit tree contains validated `review.json`: schema, stable ID, title, author, creation time, retained comparisons (`revisions`), comments, and optional branch tracking metadata. Comparisons retain exact base/head IDs and an internal UUID; old comments continue to reference that UUID and their head commit. Existing records are not rewritten when a branch advances.

Tracking metadata records the published branch name, fixed base, initial reviewed head, and an optional initially cached remote head. It is shared independently of local remote aliases. Current observations are private JSON blobs at `refs/git-discuss/tracking/<review-id>` and are never pushed by application sync. They allow a branch to return to an already retained commit without duplicating history or relying on commit timestamps to guess which code is current. Public comparison snapshots and their local observation pointers are published in one guarded transaction. If a foreground writer changes a review during code fetching, the entire background publication is retried from fresh data.

Every write creates a new snapshot commit. Its first parent is the previous snapshot when one exists. Creation and revision writes also link their base/head code commits as parents (duplicates removed). These links retain all reviewed commits and trees even after branches are rewritten or deleted and Git garbage collection runs. Comment-only writes retain code through their previous snapshot. Review snapshots are application metadata commits, not code commits to merge into a working branch.

Writers hold the repository-wide application lock and publish the snapshot with `git update-ref` using the expected previous object ID. A failed or interrupted write before publication leaves the previous snapshot intact; unpublished objects can be garbage-collected. Ordinary writes change one ref atomically; sync publishes its local ref updates together. Sync merge snapshots retain local and remote histories as parents. Edits and web deletions append change records without rewriting original records; deleted review refs are retained to preserve the deletion and reviewed code. There is currently no automatic commit-to-review notes index or conversion of commit notes into reviews.

### Commit-linked notes

This version stores a plain-text/Markdown blob on each annotated commit at `refs/notes/git-discuss`. Add, edit, append, and delete rewrite the current notes tree under the application lock, with previous versions retained in Git's notes commit history. Note blob IDs provide optimistic edit/delete version checks. Local-only notes do not guarantee retention of their annotated code after history rewriting. Sync snapshots add code-retention parent links before sharing notes. Read the current text with `git notes --ref=git-discuss show <commit>` and its history with `git log --first-parent refs/notes/git-discuss`.

In **Change notes**, expand **Git details** to see the code commit's author and committer (including email addresses), authored and committed timestamps with UTC offsets, and full commit, tree, and parent SHAs. The separate **Note storage** section shows the notes ref and current note blob SHA. Code author metadata is not the author of the note; note authorship is recorded in the notes ref's Git history.

### Boundaries

- Tracked reviews follow pushed source-branch commits while preserving earlier discussion anchors. Pinned reviews and standalone commit notes stay on their exact code snapshots. The comparison base is fixed at review creation/connection; following a moving target/base branch is not implemented.
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
