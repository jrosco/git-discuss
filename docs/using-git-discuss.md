# Using Git Discuss

Git Discuss has two workspaces: **Reviews** for evolving branches, and **Change notes** for discussion attached to a single commit.

## Start a review

1. Choose **Start a review** and enter a title.
2. Select the branch to review. **My current saved code** means the current Git commit (`HEAD`).
3. Select an explicit base branch or commit to compare against. Git Discuss does not silently infer a base.
4. Create the review, inspect **Code changes**, and use **Discuss these changes** to leave feedback.

Reviews follow the selected head branch by default. Their starting base remains fixed. A commit, tag, or detached `HEAD` creates a pinned comparison; use **Follow a branch** to connect an older pinned review to a branch.

After new code is pushed, **Check latest code**, background checks, or **Share & get updates** retain its comparison in the same review. Old comments stay attached to the exact commit they were written on. If there is a draft, Git Discuss keeps it pinned to its original commit while incoming updates are displayed.

Branch and commit selectors search local and last-downloaded team branches. They do not check out branches or change working files. Only committed code is reviewed; uncommitted file edits are not included.

## Discuss code and commits

Review comments are threaded and anchored to a saved comparison. **Code history** lists retained commits; choose one and open **Code changes** to see its exact base/head diff. The viewer highlights additions, deletions, and hunk headers. Binary changes are shown with Git's markers. Diffs over 2 MiB or 20,000 lines show an error and a local `git diff <base> <head>` fallback.

Click a **Commit abc123 ↗** link to open the original comparison for a comment. Older comments are never moved to newer code. A draft stays with the commit it started on; changing the selected comparison prompts before discarding an unsaved new-comment draft.

The first comment in a review thread has **Resolve thread** / **Reopen thread** controls. Resolve collapses the thread while keeping its history, author, timestamp, and commit links available. Reopen a thread before replying. Edits, deletions, and replies retain history; feedback arriving after a resolution reopens the thread.

## Change notes

Use **Change notes** to leave one plain-text/Markdown note on a specific saved commit. Notes and review conversations are separate. You can add, edit, append, or delete a note; edits and deletions retain previous versions in Git history.

The commit picker searches branch names, commit IDs, subjects, and authors. **Show older results** loads more history. **Show only commits with notes** filters loaded commits. Browsing does not fetch or check out branches.

## Save and share

- **Save locally** stores feedback in Git on this computer, without pushing it.
- **Save & share now** saves first, then syncs all local reviews and notes with the selected team remote.
- **Share & get updates** exchanges saved feedback after the fact.

Draft text is never uploaded. Saving or sharing does not stage files, alter code commits, or create commits in the working branch. Sync uses the selected Git remote and your existing Git credentials.

The web interface opens in your default browser. Its tab title includes the repository name. Light/dark appearance is remembered per local server address; a new server port has separate browser storage.

For command examples, see the [CLI reference](cli.md). For remote setup and background checks, see [Sharing and sync](sharing.md).
