# Technical reference

This page collects protocol, versioning, and reconciliation details for maintainers and advanced users.

## Review tracking

- A local branch follows the matching `refs/heads/<name>` on the selected team remote. Git's upstream setting is not substituted; a feature branch can still have `main` as its upstream.
- A remote-tracking branch follows its published branch name on the selected remote. Remote aliases such as `origin` remain local to each clone.
- Review creation captures the base explicitly and does not recompute a merge base as code advances. An existing pinned review can be connected to a branch once; its old comments and comparisons remain intact.
- Once a new pushed tip is observed, tracking follows later rebases and backward moves. Re-observing a saved commit reuses its comparison. If the source branch disappears, the review keeps its last saved code and reports the missing branch.
- Tracking state and locally observed comparisons are private clone metadata. Sync publishes review content and retained comparisons, not local remote aliases or private tracking observations.

## Comment and deletion history

Review comments have immutable IDs and append-only edit, delete, resolve, and reopen records. Replies retain their parent IDs, and old comments stay anchored to their original comparison. Resolve/reopen changes retain the comment-content versions they cover; a stale resolution is rejected if the thread changed after it was loaded.

Concurrent changes to the same comment or title remain in history and are displayed in deterministic merged order. Deletion takes precedence over edits. If new feedback arrives after a resolution, the thread reopens so feedback is not hidden as completed. Deleted reviews retain a marker so a later sync does not resurrect an older copy.

Review deletion through the browser is shared on the next sync. The `git discuss review delete` command removes the review ref only in the current clone. Neither operation securely erases Git history.

## Notes and limits

Commit notes are plain-text/Markdown blobs attached through `refs/notes/git-discuss`; they are distinct from review conversations. The browser's complete note text is limited to 100,000 characters and review comments to 20,000 characters. Notes are stored verbatim, including whitespace. Browser edit/delete API calls include the loaded note version to reject stale writes.

Tracked reviews use schema version 3; older pinned reviews use versions 1/2. Review edits and deletions append history records rather than rewriting original metadata. Clients that do not understand newer schema or change kinds reject them instead of silently discarding data.

## Local HTTP API

The desktop and CLI use the same loopback server. It binds only to `127.0.0.1` and requires the launch token as a Bearer credential on API requests. The token is carried in the URL fragment, not sent in the HTTP request URL. Host and Origin checks reject requests from other origins.

The API covers repository and remote information, branch/commit browsing, review/comment/note mutations, sync/receive, revision diffs, and background-update status. Mutations use the same repository lock and compare-and-swap checks as CLI writes.

Background update endpoints:

- `GET /api/background-updates` returns status.
- `POST /api/background-updates` configures `{ "enabled": true, "remote": "origin" }`.
- `POST /api/background-updates/check` requests a receive-only check while enabled.
- `POST /api/receive` performs a foreground receive-only check even when automatic updates are disabled.

None of these receive-only operations pushes local work. `POST /api/sync` and `git discuss sync` perform reconciliation and may publish discussion refs.

## Reconciliation details

Review additions and edits combine by immutable ID. Tracked comparisons merge as a deduplicated set, so observers can retain the same commits in different orders after a rebase. Automatic comparisons use deterministic IDs derived from the review ID and exact base/head pair.

Plain notes reconcile per annotated commit using common notes history. Independent notes on different commits, one-sided edits, and independent appends can merge. Conflicting replacements or an edit racing with deletion stop publication before local discussion refs are changed; no side is silently preferred.

Explicit sync holds the application lock while reconciling and publishing. Background checks prepare outside the lock and publish through a short guarded atomic transaction. If another writer changes a ref while a check is preparing, publication is rejected and retried from fresh local data. Temporary refs under `refs/git-discuss/background/*` and `refs/git-discuss/sync/*` are cleaned after handled success or failure.

Successful sync publishes reconciled refs atomically, then uses an atomic non-forced push. A failed upload leaves reconciled work saved locally; retry sync after resolving the network or remote update. There is no partial-push fallback.
