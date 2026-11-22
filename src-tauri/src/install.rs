//! Install Claude Code Skill… (menu.rs): sets up what a /flyover-review session needs when only the app is installed.
//!
//! - A `flyover` command (the shim): a small script that runs the app's own copy of bin/flyover.mjs with `node`, so
//!   `flyover export` and `flyover import` work in a terminal and for any agent. It goes in ~/.local/bin on macOS and
//!   Linux (we only report when that folder isn't on your PATH; we don't edit your shell files), and in
//!   ~/.code-flyover/bin on Windows, which is added to your user PATH.
//! - The skills: each skills/<name>/SKILL.md in the app's files (/flyover-review, /flyover-describe), copied to
//!   ~/.claude/skills/<name>/, with the line naming its command pointed at the shim by full path, so the skills work
//!   whether or not the shim is on the PATH.
//!
//! Neither overwrites something that isn't ours: a `flyover` that isn't a shim we wrote (an `npm link` from a
//! checkout, say) is left alone, and so is a skill folder that's a symlink (a checkout linked in by hand, as the
//! README describes). Running it again after an update just rewrites both.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The first line of every shim we write (after the shebang), so we know which `flyover` files are ours to replace.
const MARKER: &str = "Written by Code Flyover (Install Claude Code Skill…)";
/// The sentence in SKILL.md that names the command. The copy we install points it at the shim.
const COMMAND_LINE: &str = "The command is `flyover`";

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Couldn't find your home folder.".into())
}

/// Where the shim goes, and the folder that has to be on the PATH for `flyover` to work in a terminal.
fn shim_path(home: &Path) -> PathBuf {
    if cfg!(windows) {
        home.join(".code-flyover").join("bin").join("flyover.cmd")
    } else {
        home.join(".local").join("bin").join("flyover")
    }
}

fn shim_text(script: &Path) -> String {
    if cfg!(windows) {
        format!("@echo off\r\nrem {MARKER}\r\nnode \"{}\" %*\r\n", script.display())
    } else {
        format!("#!/bin/sh\n# {MARKER}\nexec node \"{}\" \"$@\"\n", script.display())
    }
}

/// Writes the shim, unless a `flyover` that isn't ours is already there.
fn write_shim(path: &Path, script: &Path) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(path) {
        if !existing.contains(MARKER) {
            return Err(format!("{} already exists and wasn't written by Code Flyover, so it was left alone.", path.display()));
        }
    } else if path.symlink_metadata().is_ok() {
        return Err(format!("{} already exists and wasn't written by Code Flyover, so it was left alone.", path.display()));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    fs::write(path, shim_text(script)).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| format!("Couldn't make {} runnable: {e}", path.display()))?;
    }
    Ok(())
}

/// Whether `dir` is on the PATH a new terminal gets: your login shell's on macOS and Linux (the app's own PATH is
/// launchd's, which never has ~/.local/bin), the user and system PATH from the registry on Windows.
fn on_path(dir: &Path) -> bool {
    #[cfg(windows)]
    let path = Command::new("powershell")
        .args(["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    #[cfg(not(windows))]
    let path = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        Command::new(shell)
            .args(["-l", "-i", "-c", "printf %s \"$PATH\""])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let sep = if cfg!(windows) { ';' } else { ':' };
    path.split(sep).any(|p| Path::new(p.trim()) == dir)
}

/// Adds `dir` to the user PATH in the registry (Windows only). Terminals opened afterwards see it.
#[cfg(windows)]
fn add_to_path(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // The folder is passed as an environment variable, not spliced into the script, so no quoting can break it.
    let script = "$d = $env:FLYOVER_BIN; $p = [Environment]::GetEnvironmentVariable('Path','User'); \
                  if (-not $p) { $p = $d } elseif (($p -split ';') -notcontains $d) { $p = $p.TrimEnd(';') + ';' + $d }; \
                  [Environment]::SetEnvironmentVariable('Path', $p, 'User')";
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .env("FLYOVER_BIN", dir)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map_err(|e| format!("Couldn't run PowerShell to add {} to your PATH: {e}", dir.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Couldn't add {} to your PATH.", dir.display()))
    }
}

/// The skills the app carries: each folder in skills/ with a SKILL.md, by name.
fn bundled_skills(app_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(app_dir.join("skills"))
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .filter(|e| e.path().join("SKILL.md").is_file())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Copies one bundled skill into ~/.claude/skills, with the line naming its command pointed at `command`.
fn write_skill(app_dir: &Path, home: &Path, name: &str, command: &str) -> Result<(), String> {
    let source = app_dir.join("skills").join(name).join("SKILL.md");
    let text = fs::read_to_string(&source).map_err(|e| format!("Couldn't read {}: {e}", source.display()))?;
    let Some(start) = text.find(COMMAND_LINE) else {
        return Err(format!("/{name}: {} doesn't name its command the way this app expects, so it wasn't installed.", source.display()));
    };
    let end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    let text = format!("{}The command is `{command}` (shortened to `flyover` below).{}", &text[..start], &text[end..]);
    let dir = home.join(".claude").join("skills").join(name);
    if dir.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        let target = fs::read_link(&dir).map(|t| t.display().to_string()).unwrap_or_default();
        return Err(format!("/{name}: {} is a link to {target}, so it was left alone.", dir.display()));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let dest = dir.join("SKILL.md");
    fs::write(&dest, text).map_err(|e| format!("Couldn't write {}: {e}", dest.display()))
}

/// Does the install and says what happened, one line per part. `Err` only when nothing useful got done.
fn install(app_dir: &Path) -> Result<String, String> {
    let home = home()?;
    let script = app_dir.join("bin").join("flyover.mjs");
    let shim = shim_path(&home);
    let mut lines = Vec::new();

    // The skill names the shim when it's ours, else runs the app's script directly, so it works either way.
    let command = match write_shim(&shim, &script) {
        Ok(()) => {
            let dir = shim.parent().unwrap_or(&home);
            #[cfg(windows)]
            let path_note = if on_path(dir) {
                String::new()
            } else {
                match add_to_path(dir) {
                    Ok(()) => " (added to your PATH; open a new terminal to use it)".into(),
                    Err(e) => format!(". {e}"),
                }
            };
            #[cfg(not(windows))]
            let path_note = if on_path(dir) {
                String::new()
            } else {
                format!(". {} isn't on your PATH, so add it to your shell profile to type `flyover` in a terminal (the skill doesn't need it)", dir.display())
            };
            lines.push(format!("The `flyover` command: {}{path_note}.", shim.display()));
            if cfg!(windows) {
                // Claude Code runs commands in Git Bash on Windows, which can't run a .cmd by its bare path.
                format!("node \"{}\"", script.display().to_string().replace('\\', "/"))
            } else {
                shim.display().to_string()
            }
        }
        Err(e) => {
            lines.push(e);
            format!("node \"{}\"", script.display())
        }
    };

    let names = bundled_skills(app_dir);
    if names.is_empty() {
        lines.push(format!("No skills found in {}.", app_dir.join("skills").display()));
    }
    let mut installed = Vec::new();
    for name in &names {
        match write_skill(app_dir, &home, name, &command) {
            Ok(()) => installed.push(format!("/{name}")),
            Err(e) => lines.push(e),
        }
    }
    if !installed.is_empty() {
        let dir = home.join(".claude").join("skills");
        lines.push(format!(
            "Skills {}, in {}. They show up in Claude Code sessions started from now on.",
            installed.join(" and "),
            dir.display()
        ));
    }
    Ok(lines.join("\n\n"))
}

/// The menu item: asks first, installs, then says what it did. Runs off the main thread, since the dialogs block.
pub fn run(app: &AppHandle, app_dir: PathBuf) {
    let app = app.clone();
    thread::spawn(move || {
        let home = home().map(|h| h.display().to_string()).unwrap_or_else(|_| "~".into());
        let shim = home.clone() + if cfg!(windows) { r"\.code-flyover\bin\flyover.cmd" } else { "/.local/bin/flyover" };
        let ask = format!(
            "This installs two things, so a Claude Code session can write a review for the map:\n\n\
             • a `flyover` command at {shim}, for `flyover export` and `flyover import`\n\
             • the Code Flyover skills (/flyover-review and the rest), in {home}{sep}.claude{sep}skills\n\n\
             Run it again after updating the app.",
            sep = std::path::MAIN_SEPARATOR,
        );
        let go = app
            .dialog()
            .message(ask)
            .title("Install Claude Code Skill")
            .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Cancel".into()))
            .blocking_show();
        if !go {
            return;
        }
        let (text, kind) = match install(&app_dir) {
            Ok(t) => (t, MessageDialogKind::Info),
            Err(e) => (e, MessageDialogKind::Error),
        };
        app.dialog().message(text).title("Install Claude Code Skill").kind(kind).blocking_show();
    });
}
