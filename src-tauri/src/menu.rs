//! The menu bar. The app's own items (Settings, Check for Updates, Open Repo, Whole Repo, Code, Docs, Tests, Translations, Fit Map, Update Branch) send their id to the page as the
//! `native-menu` event (lib.rs), which runs them, except Install Claude Code Skill…, which lib.rs runs itself
//! (install.rs); the rest are system items.

use tauri::menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// macOS keeps the usual app menu. Windows and Linux have no app menu and don't support several of the system items
/// (Quit, Close Window, Fullscreen and Hide are unsupported on GTK 3; Fullscreen and Hide on Windows), so there
/// those few are our own items, which lib.rs handles itself (`quit`, `close-window`, `fullscreen`).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accelerator: &str| MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app);
    let about = AboutMetadata { name: Some("Code Flyover".into()), ..Default::default() };

    // Copy and Select All have to be here for Cmd/Ctrl+C and +A to work in the page.
    #[cfg(target_os = "macos")]
    let edit_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![
        Box::new(PredefinedMenuItem::undo(app, None)?),
        Box::new(PredefinedMenuItem::redo(app, None)?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(PredefinedMenuItem::cut(app, None)?),
        Box::new(PredefinedMenuItem::copy(app, None)?),
        Box::new(PredefinedMenuItem::paste(app, None)?),
        Box::new(PredefinedMenuItem::select_all(app, None)?),
    ];
    #[cfg(not(target_os = "macos"))]
    let edit_items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = vec![
        Box::new(PredefinedMenuItem::cut(app, None)?),
        Box::new(PredefinedMenuItem::copy(app, None)?),
        Box::new(PredefinedMenuItem::paste(app, None)?),
        Box::new(PredefinedMenuItem::select_all(app, None)?),
    ];
    let edit_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = edit_items.iter().map(|i| i.as_ref()).collect();
    let edit = Submenu::with_items(app, "Edit", true, &edit_refs)?;

    #[cfg(target_os = "macos")]
    {
        // Two groups: the app's own (About, Check for Updates, Install, Settings), then the system's (Hide…, Quit). Quit stays with Hide
        // so it isn't alone between dividers.
        let app_menu = Submenu::with_items(
            app,
            "Code Flyover",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Code Flyover"), Some(about))?,
                &MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?,
                &MenuItemBuilder::with_id("install-skill", "Install Claude Code Skill…").build(app)?,
                &item("settings", "Settings…", "CmdOrCtrl+,")?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let file = Submenu::with_items(app, "File", true, &[&item("open-repo", "Open Repo…", "CmdOrCtrl+O")?, &PredefinedMenuItem::close_window(app, None)?])?;
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &MenuItemBuilder::with_id("whole-repo", "Changes / Whole Repo (U)").build(app)?,
                &MenuItemBuilder::with_id("show-code", "Show Code (C)").build(app)?,
                &MenuItemBuilder::with_id("show-docs", "Show Docs (D)").build(app)?,
                &MenuItemBuilder::with_id("show-tests", "Show Tests (T)").build(app)?,
                &MenuItemBuilder::with_id("show-locales", "Show Translations (L)").build(app)?,
                &PredefinedMenuItem::separator(app)?,
                &item("whole-map", "Fit Map", "CmdOrCtrl+0")?,
                &item("update-branch", "Update Branch", "CmdOrCtrl+R")?,
                &PredefinedMenuItem::fullscreen(app, None)?,
            ],
        )?;
        let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
    }
    #[cfg(not(target_os = "macos"))]
    {
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &item("open-repo", "Open Repo…", "CmdOrCtrl+O")?,
                &MenuItemBuilder::with_id("install-skill", "Install Claude Code Skill…").build(app)?,
                &item("settings", "Settings…", "CmdOrCtrl+,")?,
                &PredefinedMenuItem::separator(app)?,
                &item("close-window", "Close Window", "CmdOrCtrl+W")?,
                &item("quit", "Quit", "CmdOrCtrl+Q")?,
            ],
        )?;
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &MenuItemBuilder::with_id("whole-repo", "Changes / Whole Repo (U)").build(app)?,
                &MenuItemBuilder::with_id("show-code", "Show Code (C)").build(app)?,
                &MenuItemBuilder::with_id("show-docs", "Show Docs (D)").build(app)?,
                &MenuItemBuilder::with_id("show-tests", "Show Tests (T)").build(app)?,
                &MenuItemBuilder::with_id("show-locales", "Show Translations (L)").build(app)?,
                &PredefinedMenuItem::separator(app)?,
                &item("whole-map", "Fit Map", "CmdOrCtrl+0")?,
                &item("update-branch", "Update Branch", "CmdOrCtrl+R")?,
                &item("fullscreen", "Toggle Full Screen", "F11")?,
            ],
        )?;
        // Updates, then About, as Help menus go.
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[&MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?, &PredefinedMenuItem::about(app, Some("About Code Flyover"), Some(about))?],
        )?;
        Menu::with_items(app, &[&file, &edit, &view, &help])
    }
}
