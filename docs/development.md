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
