# Desktop app

Git Discuss runs in the system tray and opens its web interface in your default browser. It can keep multiple repositories open at once, with one local server per repository.

## Tray menu

- **Open Git Discuss** opens the active repository. If none is active, choose one first.
- **Open repository…** starts a server for another repository without closing the ones already running.
- **Running repositories** switches to an open repository. Reopening the same repository reuses its server.
- **Recent repositories** lists up to eight recently used paths.
- **Close repository** stops just that repository's server.
- **Quit** stops all servers.

The last-used repository starts automatically with the app. Other recent repositories start only when selected. Closing a browser tab does not stop its server.

## Install the terminal command

The desktop package includes the `git-discuss` executable and its Node runtime:

- The Windows installer adds it to the current user's `PATH`. Open a new terminal after installing.
- The Debian package registers it as `/usr/bin/git-discuss`.
- On macOS, add the app's bundled command to a directory on your `PATH`:

  ```sh
  mkdir -p "$HOME/.local/bin"
  ln -s "/Applications/Git Discuss.app/Contents/Resources/resources/bin/git-discuss" "$HOME/.local/bin/git-discuss"
  ```

  Ensure `$HOME/.local/bin` is on your `PATH`.
- The AppImage includes the command inside its resources. To use it from `PATH`, extract the AppImage and link the included wrapper.

## Build from source

The following commands run on the current platform; installers are built on Windows, macOS, and Linux build hosts respectively.

```sh
npm install
npm run desktop:dev   # run the tray app from this checkout
npm run desktop:dist  # create the platform installer
```

Windows PowerShell users can use `npm.cmd` instead of `npm`. Building requires Node.js 22.12+, Rust, and the platform prerequisites in the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/). Installers are written under `src-tauri/target/release/bundle/`.
