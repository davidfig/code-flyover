//! The menu bar. The app's own items (Open Repo, Whole Map, Update Branch) send their id to the page as the
//! `native-menu` event (lib.rs), which runs them; the rest are system items.

use tauri::menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accelerator: &str| MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app);
    let about = AboutMetadata { name: Some("Semantic Zoom".into()), ..Default::default() };

    // One group each: About, Hide and Quit read fine together, and a lone About or Quit between dividers wouldn't.
    let app_menu = Submenu::with_items(
        app,
        "Semantic Zoom",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Semantic Zoom"), Some(about))?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(app, "File", true, &[&item("open-repo", "Open Repo…", "CmdOrCtrl+O")?, &PredefinedMenuItem::close_window(app, None)?])?;
    // Copy and Select All have to be here for ⌘C and ⌘A to work in the page.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("whole-map", "Whole Map", "CmdOrCtrl+0")?,
            &item("update-branch", "Update Branch", "CmdOrCtrl+R")?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}
