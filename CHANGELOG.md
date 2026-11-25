# Changelog

What changed in each release of Code Flyover. The newest release is at the top.

This file is the one source: the app shows it under What's New, and `npm run changelog:site` turns it into
codeflyover.app/changelog. Add a line under Unreleased as you go; on a release, rename Unreleased to the new version and
its date and start a fresh Unreleased above it.

## Unreleased

### Added

- Hovering a file's name shows its own opening comment, in any of the common languages. Hovering a folder's shows its
  README's first paragraph, or its index file's opening comment.
- A Keyboard section in Settings, where you can change or remove each shortcut.

### Changed

- ↓ and ↑ scroll the selected file. Shift with → or ← moves to the next or previous section instead.
- Code is coloured with VS Code's grammars (through Shiki), so nested template strings, JSX and embedded languages come
  out right. Files show at once in the old colours and get the better ones moments later.

### Removed

- `flyover describe` and the `/flyover-describe` skill: files' own comments and folders' READMEs do the job now. Notes
  already written still show until their file changes.

### Fixed

- The app couldn't start its server from a read-only folder, such as a Linux AppImage's.
- A quote or backtick inside a regex (JavaScript, TypeScript, Vue, Svelte, Astro, Ruby) no longer colours the code after it as a string.
- `flyover export` and `import` did nothing in the installed app (they looked for a file the app doesn't include).

## 0.1.6 - 2026-11-24

### Fixed

- **Check for Updates…** and **Restart to update** failed with "not allowed by ACL". Versions before this one can't
  update themselves: download this one once, and updates work from then on.

## 0.1.5 - 2026-11-24

### Added

- A title bar on the file you're reading, with its name, folder, status and line counts. It stays at the top of the
  file as you scroll; hover it for the file's summary. Other files' name tags stay in view too, when their tops are off screen.
- Pull request numbers (#123) in the branch list, with a new setting that's off by default. They come from GitHub
  through git, with the sign-in it already uses, so there's nothing to install.
- A scroll bar on every file with more to show than fits in its box, selected or not. Drag it, or click to jump.
- → and ← move to the next and previous file, through each group and on to the next; ↓ and ↑
  go to the first file of the next and previous section. They work while the map has the focus. The view slides so the file's
  top-left corner lands where the last one's was, at the same zoom.

### Changed

- The map is packed tighter, so everything on it is bigger with the whole map in view: fewer holes, columns not
  stretched past their text, and less margin. It's laid out again when the window changes shape.

## 0.1.4 - 2026-11-24

### Added

- Dependencies for Python, Go, C#, Java, Kotlin, Scala, Swift, PHP, Ruby, C/C++/Objective-C, Dart and Lua, and for the
  scripts in Vue, Svelte and Astro files, as well as TypeScript/JavaScript and Rust. Their tests are recognised
  (`test_*.py`, `*_test.go`, `FooTest.java`, `MyApp.Tests/`, `*_spec.rb` and so on), and new third-party imports are
  flagged for Python, Go and Dart.
- Every other text file is on the map too: config, styles, HTML, shell scripts and languages without a dependency
  finder. They're diffed and coloured like code, and linked to the repo files they name. Lockfiles count as
  generated.
- Syntax colouring for all of these, and plain text for anything else.

## 0.1.3 - 2026-11-23

### Added

- The Mac app is signed with a Developer ID and notarized by Apple, so macOS opens it without a warning.
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
