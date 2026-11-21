// Semantic Zoom in its own window. The app is the same web app `semantic-zoom` serves (Vite with the API in
// server/api.ts, from this checkout): this starts that server, or uses one already running, and shows it. The window
// adds what a browser tab can't: a Dock icon, the menu bar (menu.rs), and a native folder picker for Open Repo.
//
// The server runs from the checkout this was built from (APP_DIR), with Node found through your login shell, so it has
// the same PATH and environment (git, node, ANTHROPIC_API_KEY) as your terminal. It's stopped when the app quits, unless
// it was already running before (from `semantic-zoom` or another copy of the app).

mod menu;

use std::fs::{self, File};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, RunEvent};

/// The checkout this app runs from: the folder above src-tauri.
const APP_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
/// The app's port, as `semantic-zoom` uses (bin/semantic-zoom.mjs).
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

fn log_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join(".semantic-zoom").join("app-server.log")
}

/// Starts the server through your login shell (`-l -i`: your profile and rc files, so `node`, `git` and API keys are
/// found as in a terminal). `exec` makes node the process itself, so stopping it stops the server.
fn start_server() -> std::io::Result<Child> {
    let log = log_path();
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir)?;
    }
    let out = File::create(&log)?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .args(["-l", "-i", "-c", "exec node bin/semantic-zoom.mjs --serve"])
        .current_dir(APP_DIR)
        .env("SEMANTIC_ZOOM_PORT", PORT.to_string())
        .stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(out)
        .spawn()
}

/// Asks the server to stop (SIGTERM, so Vite can close its own helpers) and waits briefly for it.
fn stop_server(child: &mut Child) {
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
        match start_server() {
            Ok(child) => *app.state::<Server>().0.lock().unwrap() = Some(child),
            Err(e) => return fail(format!("Couldn't run your shell to start the server: {e}")),
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
        .on_menu_event(|app, event| {
            let _ = app.emit("native-menu", event.id().0.clone());
        })
        .setup(|app| {
            let handle = app.handle().clone();
            thread::spawn(move || connect(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Semantic Zoom");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                stop_server(&mut child);
            }
        }
    });
}
