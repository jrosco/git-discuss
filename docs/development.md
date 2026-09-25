# Development

## Requirements

- Node.js 22.12+ and npm
- Rust stable and Tauri platform prerequisites
- Git on `PATH`
- An existing Git repository with at least one commit
- Git `user.name` and `user.email` configured to post comments

Tauri packaging requires MSVC build tools on Windows, Xcode Command Line Tools on macOS, and WebKitGTK/GTK development packages on Linux. Build each platform on its native host or use a CI matrix.

## Build and run

```sh
npm install
npm run build
npm run desktop:dev
```

`desktop:dev` builds the browser assets, stages the production-only Node sidecar, generates app icons, and runs the Tauri tray host. The desktop app opens the UI in the default browser.

Build installers for the current platform with:

```sh
npm run desktop:dist
```

Installer artifacts are written under `src-tauri/target/release/bundle/`. `npm run desktop:pack` compiles the Tauri binary without creating an installer.

The tray host bundles its own Node runtime and production dependencies. `scripts/prepare-tauri-resources.mjs` stages only runtime JavaScript, web assets, and production `node_modules` before packaging; it copies the current build host's Node executable for that platform.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
```

Tests create temporary Git repositories. The smoke test runs the built CLI and checks browser assets and persisted notes.

## GitHub Actions

Pull requests run the test suite and Tauri host compile checks on Windows, macOS, and Linux. A title check requires `<type>: <description>` (optionally with a scope and `!`), such as `feat(ui): add review filters` or `fix!: change the CLI contract`. Release Please reads Conventional Commits on `main` and opens a release PR with the next SemVer version: `fix:` means patch, `feat:` means minor, and breaking changes marked with `!` or a `BREAKING CHANGE:` footer mean major. Types such as `docs:`, `chore:`, and `style:` do not trigger a release on their own. The PR updates the npm and Rust package versions; Tauri reads its app version from `package.json`. Merging the release PR creates the GitHub release and triggers builds for all desktop installers.

For reliable title-based bumps, enable squash merging and set the repository's default squash commit message to the pull request title. Require the **Validate PR title** status check in branch protection/rulesets. Also allow GitHub Actions to create pull requests in repository settings.
