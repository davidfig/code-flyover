fn main() {
    // The page is served from localhost, which Tauri counts as remote: it may only call the app's own commands that
    // are declared here and allowed in capabilities/default.json. A new command (lib.rs, invoke_handler) goes in both.
    let commands = tauri_build::AppManifest::new().commands(&["update_ready", "check_for_updates", "install_update"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands)).expect("failed to run tauri-build");
}
