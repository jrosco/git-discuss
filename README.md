# Git Discuss

Git Discuss is a local-first tool for reviewing code and discussing commits. Reviews and notes are stored in Git and shared through a remote you already use—no separate account or hosted review service.

## What you can do

- Review a branch against an explicit base and keep the conversation as the branch changes.
- Leave threaded comments on reviewed code, or notes on an individual commit.
- Save feedback locally and choose when to share it with your team.
- Open the same discussions in a browser or from the `git discuss` command.

Git Discuss works with committed code. It does not check out branches, change working files, or stage code.

## Get started

You need Git, a repository with at least one commit, and a configured Git author name and email to post feedback.

With the desktop app, open Git Discuss from the system tray and choose a repository. The web interface opens in your default browser; multiple repositories can stay open at once.

To run from a source checkout:

```sh
npm install
npm run build
node dist/cli.js --repo "/path/to/repository" serve
```

Windows PowerShell users can run `npm.cmd` instead of `npm`. The server prints a local URL and opens the browser. Use the complete URL, including its authentication fragment.

```sh
git discuss serve
git discuss sync
```

The desktop installer bundles the CLI command. Windows and Debian installers add it to `PATH`; see the [desktop guide](docs/desktop.md) for macOS and AppImage setup. See the [CLI guide](docs/cli.md) for source-checkout use.

## Guides

- [Using reviews and change notes](docs/using-git-discuss.md)
- [Desktop app and installation](docs/desktop.md)
- [CLI reference](docs/cli.md)
- [Sharing, automatic updates, and conflicts](docs/sharing.md)
- [Architecture and Git storage](docs/architecture.md)
- [Technical reference](docs/technical-reference.md)
- [Development and platform builds](docs/development.md)
