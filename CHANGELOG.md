# Changelog

What changed in each release of Code Flyover. The newest release is at the top.

This file is the one source: the app shows it under What's New, and `npm run changelog:site` turns it into
codeflyover.app/changelog. Add a line under Unreleased as you go; on a release, rename Unreleased to the new version and
its date and start a fresh Unreleased above it.

## Unreleased

### Added

- What's New, in the app menu (the Help menu on Windows and Linux) and in Settings, shows this changelog. It's part of
  the app, so it works offline.
- A changelog page on codeflyover.app.

## 0.1.1 - 2026-11-22

### Added

- The desktop app updates itself from GitHub Releases. It checks when it starts and every six hours, downloads and
  verifies a signed update in the background, then offers **Restart to update**. Nothing installs until you click it.
  **Check for Updates…** in the menu checks now.
- **Install Claude Code Skill…** in the menu installs the `/flyover-review` and `/flyover-describe` skills and a
  `flyover` command, for when only the app is installed.
- `/flyover-describe` writes a sentence for every file and folder in a repo, shown when you hover its name on the map,
  on any branch. Notes are tied to file contents, so a rerun only redoes what changed.

### Changed

- Work on the map, highlighting, settings and the review command.

## 0.1.0 - 2026-11-22

The first release, as Code Flyover (it began as Semantic Zoom).

### Added

- **A map of the branch.** Changed files as columns of GitHub-style diffs, grouped by folder and module, on a map you
  zoom from the whole architecture down to the lines. Diff text is drawn on the GPU and stays smooth at every zoom.
- **Whole repo** shows every file, with the change in place; **Show** picks code, docs, tests and translations.
- **Imports.** Click a file or folder to see what it imports and what imports it. New, removed and forbidden imports
  are drawn on the map, and files that import a changed file are marked.
- **Uncommitted work** is shown with the branch, read through an index of the app's own, so your folder, index and
  branches are never touched.
- **Live view.** The map follows the branch: new commits and newly saved reviews show by themselves.
- **AI review from a Claude Code session.** `/flyover-review` writes change descriptions, two lines per changed file
  and a sentence per folder, plus bug findings, and the map shows them. The app never calls a model itself.
- **Settings**, with a filter, Import and Export, and a way back to each default.
- **Desktop app** for macOS, Windows and Linux, with native menus and a folder picker for Open Repo.
