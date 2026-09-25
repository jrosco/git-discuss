#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use open::that;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const MAX_RECENT_REPOSITORIES: usize = 8;
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(20);
const TRAY_ICON: &[u8] = include_bytes!("../../dist/tray-icon.png");

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    recent_repositories: Vec<String>,
}

struct ServerSession {
    url: String,
    child: Child,
}

#[derive(Default)]
struct SessionData {
    sessions: HashMap<String, ServerSession>,
    starting: HashSet<String>,
    active_repository: Option<String>,
    recent_repositories: Vec<String>,
    shutting_down: bool,
}

struct DesktopState {
    data: Mutex<SessionData>,
    settings_path: PathBuf,
    development_resources: PathBuf,
}

impl DesktopState {
    fn resources(&self, app: &AppHandle) -> Result<PathBuf, String> {
        let development = self.development_resources.clone();
        if development.join("app").join("dist").join("cli.js").is_file() {
            return Ok(development);
        }
        let bundled = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("resources");
        if bundled.join("app").join("dist").join("cli.js").is_file() {
            Ok(bundled)
        } else {
            Err("The bundled Git Discuss server resources could not be found.".into())
        }
    }

    fn save_settings(&self) {
        let recent = match self.data.lock() {
            Ok(data) => data.recent_repositories.clone(),
            Err(_) => return,
        };
        if let Some(parent) = self.settings_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                eprintln!("Could not create app settings directory: {error}");
                return;
            }
        }
        if let Err(error) = fs::write(
            &self.settings_path,
            serde_json::to_vec_pretty(&Settings { recent_repositories: recent })
                .unwrap_or_default(),
        ) {
            eprintln!("Could not save app settings: {error}");
        }
    }
}

fn show_error(app: &AppHandle, title: &str, message: impl Into<String>) {
    app.dialog()
        .message(message.into())
        .title(title)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn menu_item<R: tauri::Runtime>(
    app: &impl Manager<R>,
    id: impl Into<String>,
    label: impl Into<String>,
    enabled: bool,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id.into(), label.into(), enabled, None::<&str>)
}

fn refresh_menu(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<DesktopState>();
    let data = match state.data.lock() {
        Ok(data) => data,
        Err(_) => return Ok(()),
    };
    let active_label = data
        .active_repository
        .as_ref()
        .map(|root| format!("Active repository: {root}"))
        .unwrap_or_else(|| format!("{} repositories running", data.sessions.len()));

    let menu = Menu::new(app)?;
    let status = menu_item(app, "status", active_label, false)?;
    let open_active = menu_item(app, "open-active", "Open Git Discuss", true)?;
    let choose = menu_item(app, "choose-repository", "Open repository…", true)?;
    menu.append(&status)?;
    menu.append(&open_active)?;
    menu.append(&choose)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let running_heading = menu_item(app, "running-heading", "Running repositories", false)?;
    menu.append(&running_heading)?;
    if data.sessions.is_empty() {
        menu.append(&menu_item(app, "no-running", "  None", false)?)?;
    } else {
        let mut roots: Vec<_> = data.sessions.keys().cloned().collect();
        roots.sort();
        for root in roots {
            let marker = if data.active_repository.as_deref() == Some(&root) { "● " } else { "  " };
            menu.append(&menu_item(app, format!("open-running:{root}"), format!("{marker}{root}"), true)?)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let recent_heading = menu_item(app, "recent-heading", "Recent repositories", false)?;
    menu.append(&recent_heading)?;
    let recent: Vec<_> = data
        .recent_repositories
        .iter()
        .filter(|root| !data.sessions.contains_key(*root))
        .take(MAX_RECENT_REPOSITORIES)
        .cloned()
        .collect();
    if recent.is_empty() {
        menu.append(&menu_item(app, "no-recent", "  None", false)?)?;
    } else {
        for root in recent {
            menu.append(&menu_item(app, format!("open-recent:{root}"), format!("  {root}"), true)?)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let close_heading = menu_item(app, "close-heading", "Close repository", false)?;
    menu.append(&close_heading)?;
    let mut roots: Vec<_> = data.sessions.keys().cloned().collect();
    roots.sort();
    if roots.is_empty() {
        menu.append(&menu_item(app, "no-close", "  None", false)?)?;
    } else {
        for root in roots {
            menu.append(&menu_item(app, format!("close:{root}"), format!("  {root}"), true)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&menu_item(app, "quit", "Quit", true)?)?;
    drop(data);

    if let Some(tray) = app.tray_by_id("git-discuss") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn canonical_repository(path: &Path) -> Result<PathBuf, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("The selected folder is not a Git repository.".into());
    }
    Ok(PathBuf::from(root))
}

fn start_server(app: &AppHandle, repository: &Path) -> Result<ServerSession, String> {
    let resources = app
        .state::<DesktopState>()
        .resources(app)?;
    let node = resources
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let cli = resources.join("app").join("dist").join("cli.js");
    if !node.is_file() || !cli.is_file() {
        return Err("The bundled Node runtime or Git Discuss server is missing.".into());
    }

    let mut command = Command::new(node);
    command
        .arg(cli)
        .arg("--repo")
        .arg(repository)
        .arg("serve")
        .arg("--no-open")
        .current_dir(repository)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the local server: {error}"))?;
    let stdout = child.stdout.take().ok_or("Could not read the local server startup output.")?;
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                eprintln!("Git Discuss server: {line}");
            }
        });
    }

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut found_url = false;
        for line in BufReader::new(stdout).lines().flatten() {
            if !found_url {
                if let Some(url) = line.strip_prefix("Git Discuss: ") {
                    let _ = sender.send(Ok(url.trim().to_string()));
                    found_url = true;
                }
            }
        }
        if !found_url {
            let _ = sender.send(Err("The local server exited before it was ready.".to_string()));
        }
    });

    match receiver.recv_timeout(SERVER_START_TIMEOUT) {
        Ok(Ok(url)) => Ok(ServerSession { url, child }),
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("Timed out while starting the local server: {error}"))
        }
    }
}

fn save_recent(state: &DesktopState, root: &str) {
    if let Ok(mut data) = state.data.lock() {
        data.recent_repositories.retain(|item| item != root);
        data.recent_repositories.insert(0, root.to_string());
        data.recent_repositories.truncate(MAX_RECENT_REPOSITORIES);
    }
    state.save_settings();
}

fn open_url(app: &AppHandle, url: &str) {
    if let Err(error) = that(url) {
        show_error(app, "Could not open Git Discuss", error.to_string());
    }
}

fn activate_repository(app: AppHandle, selected: PathBuf, open_after_start: bool) {
    thread::spawn(move || {
        let repository = match canonical_repository(&selected) {
            Ok(repository) => repository,
            Err(error) => {
                show_error(&app, "Could not open repository", error);
                return;
            }
        };
        let root = repository.to_string_lossy().to_string();
        let state = app.state::<DesktopState>();

        let existing_url = {
            let mut data = match state.data.lock() {
                Ok(data) => data,
                Err(_) => return,
            };
            if data.shutting_down {
                return;
            }
            if let Some(session) = data.sessions.get(&root) {
                let url = session.url.clone();
                data.active_repository = Some(root.clone());
                Some(url)
            } else {
                if !data.starting.insert(root.clone()) {
                    return;
                }
                None
            }
        };

        if let Some(url) = existing_url {
            save_recent(&state, &root);
            let _ = refresh_menu(&app);
            if open_after_start {
                open_url(&app, &url);
            }
            return;
        }

        let started = start_server(&app, &repository);
        let result = match started {
            Ok(session) => {
                let url = session.url.clone();
                let mut session = Some(session);
                let installed = match state.data.lock() {
                    Ok(mut data) => {
                        data.starting.remove(&root);
                        if data.shutting_down {
                            false
                        } else {
                            data.sessions.insert(root.clone(), session.take().unwrap());
                            data.active_repository = Some(root.clone());
                            true
                        }
                    }
                    Err(_) => false,
                };
                if !installed {
                    if let Some(mut session) = session {
                        let _ = session.child.kill();
                        let _ = session.child.wait();
                    }
                    return;
                }
                save_recent(&state, &root);
                let _ = refresh_menu(&app);
                if open_after_start {
                    open_url(&app, &url);
                }
                Ok(())
            }
            Err(error) => {
                if let Ok(mut data) = state.data.lock() {
                    data.starting.remove(&root);
                }
                let _ = refresh_menu(&app);
                Err(error)
            }
        };
        if let Err(error) = result {
            show_error(&app, "Could not open repository", error);
        }
    });
}

fn open_active(app: AppHandle) {
    let url = app
        .state::<DesktopState>()
        .data
        .lock()
        .ok()
        .and_then(|data| {
            data.active_repository
                .as_ref()
                .and_then(|root| data.sessions.get(root))
                .map(|session| session.url.clone())
        });
    if let Some(url) = url {
        open_url(&app, &url);
    } else {
        choose_repository(app);
    }
}

fn choose_repository(app: AppHandle) {
    let handle = app.clone();
    app.dialog().file().pick_folder(move |selection| {
        if let Some(path) = selection.and_then(|path| path.into_path().ok()) {
            activate_repository(handle, path, true);
        }
    });
}

fn close_repository(app: &AppHandle, root: &str) {
    let session = {
        let state = app.state::<DesktopState>();
        let mut data = match state.data.lock() {
            Ok(data) => data,
            Err(_) => return,
        };
        let session = data.sessions.remove(root);
        if data.active_repository.as_deref() == Some(root) {
            data.active_repository = data.sessions.keys().next().cloned();
        }
        session
    };
    if let Some(mut session) = session {
        let _ = session.child.kill();
        let _ = session.child.wait();
        let _ = refresh_menu(app);
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if id == "open-active" {
        open_active(app.clone());
    } else if id == "choose-repository" {
        choose_repository(app.clone());
    } else if id == "quit" {
        app.exit(0);
    } else if let Some(root) = id.strip_prefix("open-running:") {
        let url = {
            let state = app.state::<DesktopState>();
            let mut data = match state.data.lock() {
                Ok(data) => data,
                Err(_) => return,
            };
            let url = data.sessions.get(root).map(|session| session.url.clone());
            if url.is_some() {
                data.active_repository = Some(root.to_string());
            }
            url
        };
        let _ = refresh_menu(app);
        if let Some(url) = url {
            open_url(app, &url);
        }
    } else if let Some(root) = id.strip_prefix("open-recent:") {
        activate_repository(app.clone(), PathBuf::from(root), true);
    } else if let Some(root) = id.strip_prefix("close:") {
        close_repository(app, root);
    }
}

fn shutdown(app: &AppHandle) {
    let sessions = {
        let state = app.state::<DesktopState>();
        let result = match state.data.lock() {
            Ok(mut data) => {
                data.shutting_down = true;
                data.sessions.drain().map(|(_, session)| session).collect::<Vec<_>>()
            }
            Err(_) => Vec::new(),
        };
        result
    };
    for mut session in sessions {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_active(app.clone())))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("settings.json");
            let settings = fs::read(&settings_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
                .unwrap_or_default();
            let state = DesktopState {
                data: Mutex::new(SessionData {
                    recent_repositories: settings.recent_repositories.into_iter().take(MAX_RECENT_REPOSITORIES).collect(),
                    ..SessionData::default()
                }),
                settings_path,
                development_resources: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
            };
            app.manage(state);

            let decoded = image::load_from_memory(TRAY_ICON)?.to_rgba8();
            let (icon_width, icon_height) = decoded.dimensions();
            let icon = Image::new_owned(decoded.into_raw(), icon_width, icon_height);
            let initial_menu = Menu::new(app)?;
            TrayIconBuilder::with_id("git-discuss")
                .icon(icon)
                .tooltip("Git Discuss")
                .menu(&initial_menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            refresh_menu(app.handle())?;

            let last_repository = app
                .state::<DesktopState>()
                .data
                .lock()
                .ok()
                .and_then(|data| data.recent_repositories.first().cloned());
            if let Some(repository) = last_repository {
                activate_repository(app.handle().clone(), PathBuf::from(repository), false);
            }
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if let RunEvent::Exit = event {
                shutdown(app);
            }
        });
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Git Discuss desktop failed to start: {error}");
    }
}
