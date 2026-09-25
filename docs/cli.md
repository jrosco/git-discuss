# Command-line reference

The desktop installer provides the `git-discuss` executable. From a source checkout, run `npm run build` and either use `node dist/cli.js` or register the executable with `npm link`. On Windows PowerShell, `npm.cmd link` avoids execution-policy issues.

Run commands inside a Git repository, or pass `--repo <path>` before the command:

```sh
git discuss serve
git discuss serve --commit main --port 43821 --no-open
git discuss show --commit HEAD
git discuss comment "Could we simplify this?" --commit HEAD
git discuss comment "More context." --commit HEAD --append
git discuss sync
git discuss sync --remote team
```

Without `--remote`, sync uses `git-discuss.remote` from the repository’s Git config, then falls back to `origin` (or the first configured remote).

`serve` starts the local browser interface. It binds only to `127.0.0.1`, selects an available port by default, and opens the browser. Use the complete URL printed by the CLI, including its authentication fragment. Stop the server with Ctrl+C.

## Reviews

```sh
git discuss review create "Simplify cache invalidation" --base main --head feature/cache
git discuss review list
git discuss review list --json
git discuss review show <review-id>
git discuss review comment <review-id> "Why invalidate here?"
git discuss review comment <review-id> "About older code" --commit <commit-sha>
git discuss review comment <review-id> "Agreed." --reply-to <comment-id>
git discuss review follow <review-id> --head feature/cache
git discuss review delete <review-id>
```

New reviews follow their selected head branch unless created with `--pinned`. The base is always captured explicitly and stays fixed. Existing reviews can be connected to a branch with `review follow`.

Review IDs and comment/reply IDs accept unambiguous prefixes of at least four characters. The review list displays eight-character prefixes and lengthens them when needed. An ambiguous prefix fails with matching IDs instead of selecting one implicitly.

`review delete` removes a review only in this clone. To propagate a deletion to teammates, use **Delete review** in the browser and then sync.

## Comment and note behavior

CLI comment commands and **Save locally** write discussion data to Git without pushing. Use `git discuss sync` to share it. `git discuss comment` creates a note and refuses to overwrite an existing note; use `--append`. The CLI does not modify working files or code commits.

See [Sharing and sync](sharing.md) for remote setup and conflicts.
