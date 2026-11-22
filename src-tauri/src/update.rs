//! Updates from the release feed, as in satchel.email. Release builds (the `updater` feature, with
//! tauri.updater.conf.json) check `latest.json` on the newest GitHub release at start and every six hours, download a
//! newer version in the background and check its signature against the public key built into the app, then tell the
//! page (`update-ready`), which offers to restart into it. Nothing installs until you click Restart to update: that
//! stops the server and closes the window, so you pick the moment. Code Flyover > Check for Updates… (Help on Windows
//! and Linux) runs the same check now and says what it found.
//!
//! Other builds have no feed: the check answers that this build doesn't update itself.

/// What a check you asked for found.
#[derive(serde::Serialize)]
pub struct UpdateCheck {
    /// The version running now.
    current: String,
    /// The newer version downloaded and waiting to be installed, if any.
    ready: Option<String>,
}

/// The version downloaded and waiting to be installed, if any. For a page that loaded after `update-ready` was sent
/// (the window first shows the loading page, and you can reload).
#[tauri::command]
pub fn update_ready(app: tauri::AppHandle) -> Option<String> {
    #[cfg(feature = "updater")]
    return feed::ready(&app);
    #[cfg(not(feature = "updater"))]
    {
        let _ = app;
        None
    }
}

/// Checks the feed now, and downloads a newer version if there is one.
#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    #[cfg(feature = "updater")]
    {
        feed::check(&app).await?;
        Ok(UpdateCheck { current: app.package_info().version.to_string(), ready: feed::ready(&app) })
    }
    #[cfg(not(feature = "updater"))]
    {
        let _ = app;
        Err("this build doesn't update itself (only the released app does)".into())
    }
}

/// Installs the downloaded update and restarts into it. The server this app started is stopped on the way out
/// (lib.rs, RunEvent::Exit), so the new version starts its own.
#[tauri::command]
pub fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(feature = "updater")]
    return feed::install(&app);
    #[cfg(not(feature = "updater"))]
    {
        let _ = app;
        Err("this build doesn't update itself".into())
    }
}

/// Adds the updater plugin, if this build has a feed.
pub fn plugin<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(feature = "updater")]
    return builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(feature = "updater"))]
    builder
}

/// Starts checking the feed, if this build has one.
pub fn start(app: &tauri::AppHandle) {
    #[cfg(feature = "updater")]
    feed::start(app);
    #[cfg(not(feature = "updater"))]
    let _ = app;
}

#[cfg(feature = "updater")]
mod feed {
    use std::sync::Mutex;
    use std::time::Duration;

    use tauri::{Emitter, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};

    const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

    /// A downloaded update whose signature checked out, with its bytes.
    #[derive(Default)]
    struct Staged(Mutex<Option<(Update, Vec<u8>)>>);

    /// Held for a whole check, so your check and the timer's never download the same update twice: the second waits,
    /// then finds it staged.
    #[derive(Default)]
    struct Checking(tauri::async_runtime::Mutex<()>);

    /// How far a download has got, for the page to show while you wait on a check you asked for (`update-progress`).
    #[derive(Clone, serde::Serialize)]
    struct Progress<'a> {
        version: &'a str,
        /// None when the server doesn't say how big the download is.
        percent: Option<u64>,
    }

    pub fn start(app: &tauri::AppHandle) {
        app.manage(Checking::default());
        app.manage(Staged::default());
        let app = app.clone();
        std::thread::spawn(move || loop {
            if let Err(e) = tauri::async_runtime::block_on(check(&app)) {
                eprintln!("update check: {e}");
            }
            std::thread::sleep(EVERY);
        });
    }

    pub async fn check(app: &tauri::AppHandle) -> Result<(), String> {
        let checking = app.state::<Checking>();
        let _one_at_a_time = checking.0.lock().await;
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
        if ready(app).as_deref() == Some(update.version.as_str()) {
            return Ok(());
        }
        let version = update.version.clone();
        // Sent when the whole percent changes, not for every chunk.
        let (mut got, mut shown) = (0u64, None);
        let mut progress = |chunk: usize, total: Option<u64>| {
            got += chunk as u64;
            let percent = total.filter(|t| *t > 0).map(|t| (got * 100 / t).min(100));
            if shown != Some(percent) {
                shown = Some(percent);
                let _ = app.emit_to("main", "update-progress", Progress { version: &version, percent });
            }
        };
        progress(0, None);
        // `download` checks the signature against the public key built into the app.
        let bytes = update.download(progress, || {}).await.map_err(|e| e.to_string())?;
        *app.state::<Staged>().0.lock().unwrap() = Some((update, bytes));
        app.emit_to("main", "update-ready", &version).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn ready(app: &tauri::AppHandle) -> Option<String> {
        app.state::<Staged>().0.lock().unwrap().as_ref().map(|(u, _)| u.version.clone())
    }

    pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
        let Some((update, bytes)) = app.state::<Staged>().0.lock().unwrap().take() else {
            return Err("no update has been downloaded".into());
        };
        // On Windows the installer takes over from here and quits the app itself.
        update.install(bytes).map_err(|e| e.to_string())?;
        // Through the event loop, so RunEvent::Exit runs first and stops the server this app started (lib.rs).
        app.request_restart();
        Ok(())
    }
}
