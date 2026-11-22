// Code Flyover in its own window. The app is the same web app `flyover` serves (Vite with the API in
// server/api.ts, from this checkout): this starts that server, or uses one already running, and shows it. The window
// adds what a browser tab can't: a Dock icon, the menu bar (menu.rs), and a native folder picker for Open Repo.
//
// The server runs from a copy of the app's files bundled with the installer (the `app` resource, made by
// stage-app.mjs), or from the checkout this was built from (APP_DIR) in a local build. Node and git are not bundled:
// on macOS and Linux they're found through your login shell, so the server has the same PATH and environment as your
// terminal; on Windows `node` is looked up on the PATH the app was started with. The server is stopped when the app
// quits, unless it was already running before (from `flyover` or another copy of the app).

mod menu;

use std::fs::{self, File};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, RunEvent};

/// The checkout this app was built from: the folder above src-tauri. Used when no bundled copy exists (local builds).
const APP_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
/// The app's port, as `flyover` uses (bin/flyover.mjs).
const PORT: u16 = 5197;
/// How long the server gets to answer before the window shows what went wrong.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// The server this app started (None when it found one already running).
#[derive(Default)]
struct Server(Mutex<Option<Child>>);

/// Whether something answers on localhost:PORT. Vite listens on whatever `localhost` resolves to first, which on macOS
/// is often only ::1, so every address is tried.
fn listening() -> bool {
    let addrs: Vec<SocketAddr> = ("localhost", PORT).to_socket_addrs().map(|a| a.collect()).unwrap_or_default();
    addrs.iter().any(|a| TcpStream::connect_timeout(a, Duration::from_millis(200)).is_ok())
}

/// Where the server's files are: the bundled `app` resource if the installer has one, else the checkout.
fn app_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("app");
        if bundled.join("bin").join("flyover.mjs").exists() {
            return strip_verbatim(bundled);
        }
    }
    PathBuf::from(APP_DIR)
}

/// Windows gives resource paths as `\\?\C:\…`, which Node and cmd can't use as a working directory.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn log_path() -> PathBuf {
    // HOME on macOS and Linux, USERPROFILE on Windows: the same folder the server (server/api.ts) keeps its state in.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let state = home.join(".code-flyover");
    // Was ~/.semantic-zoom before the rename: move it, so the server (server/api.ts) finds the repo list and reviews.
    let old = home.join(".semantic-zoom");
    if !state.exists() && old.exists() {
        let _ = fs::rename(&old, &state);
    }
    state.join("app-server.log")
}

/// Starts the server. On macOS and Linux through your login shell (`-l -i`: your profile and rc files, so `node` and
/// `git` are found as in a terminal); `exec` makes node the process itself, so stopping it stops the server. On Windows
/// `node` is run directly, found on the PATH the app inherited (the installers of Node and git put themselves there),
/// without a console window.
fn start_server(dir: &std::path::Path) -> std::io::Result<Child> {
    let log = log_path();
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent)?;
    }
    let out = File::create(&log)?;
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("node");
        c.args(["bin/flyover.mjs", "--serve"]).creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" };
        let shell = std::env::var("SHELL").unwrap_or_else(|_| fallback.into());
        let mut c = Command::new(shell);
        c.args(["-l", "-i", "-c", "exec node bin/flyover.mjs --serve"]);
        c
    };
    cmd.current_dir(dir)
        .env("FLYOVER_PORT", PORT.to_string())
        .stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(out)
        .spawn()
}

/// Asks the server to stop (SIGTERM, so Vite can close its own helpers; on Windows `taskkill` of the whole tree) and
/// waits briefly for it.
fn stop_server(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x0800_0000).status();
    }
    #[cfg(not(windows))]
    let _ = Command::new("kill").arg(child.id().to_string()).status();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

/// Waits for the server (starting it if it isn't running), then points the window at it.
fn connect(app: tauri::AppHandle) {
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };
    let fail = |text: String| {
        let _ = window.eval(&format!("showError({})", serde_json_string(&text)));
    };
    if !listening() {
        match start_server(&app_dir(&app)) {
            Ok(child) => *app.state::<Server>().0.lock().unwrap() = Some(child),
            Err(e) => return fail(format!("Couldn't start the server (is Node.js installed?): {e}")),
        }
        let started = Instant::now();
        while !listening() {
            // The server quit (no node, a syntax error, the port taken by something else): show its log.
            let exited = app.state::<Server>().0.lock().unwrap().as_mut().and_then(|c| c.try_wait().ok().flatten());
            if exited.is_some() || started.elapsed() > START_TIMEOUT {
                let log = fs::read_to_string(log_path()).unwrap_or_default();
                let why = if exited.is_some() { "The server stopped" } else { "The server didn't answer in 30 seconds" };
                return fail(format!("{why}. Its output ({}):\n\n{}", log_path().display(), log.trim()));
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    match format!("http://localhost:{PORT}/").parse() {
        Ok(url) => {
            let _ = window.navigate(url);
        }
        Err(e) => fail(format!("{e}")),
    }
}

/// A string as a JavaScript literal (JSON string syntax), for eval.
fn serde_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Reopen the window where and at the size you last left it.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Server::default())
        .menu(menu::build)
        // A menu click goes to the page, which knows what each item does (web/main.ts, the `native-menu` event).
        .on_menu_event(|app, event| match event.id().0.as_str() {
            // Windows and Linux menu items that the system items can't cover (menu.rs).
            "quit" => app.exit(0),
            "close-window" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
            "fullscreen" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
                }
            }
            id => {
                let _ = app.emit("native-menu", id.to_string());
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            thread::spawn(move || connect(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Code Flyover");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                stop_server(&mut child);
            }
        }
    });
}
