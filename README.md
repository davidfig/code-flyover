# Semantic Zoom

Code review on a map, for the human reviewer. See what a branch does and where it lands in the architecture from 1000 feet, then zoom through module → folder → file → diff.

The app helps you **understand** a change: what it does, where it sits, and whether that's where it belongs. It doesn't hunt for bugs. That's the AI review's job, and it happens in a Claude Code session, not here, so it has the full conversation, can read the code around the diff, ask questions, and carry across machines. The app's only AI use is the change descriptions.

The top level is a **difference, not a summary**: the branch's changes, described and pinned to the code they cover, over a map of the repo, with its new, removed and forbidden dependencies. The research behind this is in the vault: `Computer Science/AI Research/Semantic Zoom/Semantic Zoom Research Overview.md`.

## Use

```bash
npm install
npm link            # once: puts the semantic-zoom command on your PATH
semantic-zoom       # in any git repo (or: semantic-zoom ~/Programming/golemdocs)
```

`semantic-zoom` adds the repo to the app's list and opens http://localhost:5197/ on it, starting the app's server first if it isn't running (it stays in that terminal; Ctrl-C stops it). Pick a branch in the header: its map is made right then, in about a second, and kept in memory. Branches are listed newest first, with how far ahead of the base they are and whether they're checked out in a worktree. The side panel's **compared with** picks the base (default: the remote's default branch, e.g. `origin/main`). A branch checked out in a folder with uncommitted changes (a Claude Code session's worktree, say) is shown with them: the map reads a snapshot of that folder's files, made through an index of its own, so the folder, its index and its branches are never touched (the snapshot's objects stay in the repo's object store until `git gc`). The picker marks such branches "uncommitted changes". The view stays live: when the branch, its uncommitted files or its base change, the map is made again within a few seconds, with a note saying so. The repo menu also adds other repos by path and removes them from the list.

Everything is read from git on this machine (`git ls-tree`, `git cat-file`, `git diff`), so the repo's working tree is never touched, and nothing leaves the machine: the app never calls a model. The app's server is Vite with a small API (`vite.config.ts`, `server/api.ts`), so there's no build step; `npm run dev` runs the same app on http://localhost:5196/ for working on it. Its state is in `~/.semantic-zoom/`: the list of repos, saved change descriptions and imported AI reviews.

### Desktop app

`src-tauri/` wraps the same app in a window of its own (Tauri): a Dock icon, a menu bar (File › Open Repo… with the system's folder picker, View › Whole Map and Update Branch), and the window remembers its place. It runs the server from this checkout, so what you change here is what it shows:

```bash
cd src-tauri && cargo tauri build --bundles app   # → src-tauri/target/release/bundle/macos/Semantic Zoom.app
```

On launch it uses the server on port 5197 if one is running (say from `semantic-zoom`), or starts one through your login shell, so `node` and `git` come from your shell profile as in a terminal. It stops the server it started when you quit. If the server can't start, the window shows its output (also in `~/.semantic-zoom/app-server.log`). The icon is drawn by `src-tauri/icon.mjs`; `src-tauri/icon.sh` remakes the icon files.

### Architecture model

A repo's intended architecture (modules, which may import which, rules) is read from `.semantic-zoom.json` at its root, at the base commit, so a branch can't loosen the rules it's checked against; a branch that edits the file gets a warning saying so. Without one, `models/<repo name>.json` here is used, and failing that the model is inferred from the repo's folders (the base's dependencies count as intended). See `models/golemdocs.json` for the format.

### AI review from a Claude Code session

The app never calls a model and needs no API key. The change descriptions and the AI review it shows are written by an outside AI, a Claude Code session, so a review done there lands on the map:

```bash
semantic-zoom export [folder] [--head <branch>] [--base <ref>] > input.md   # instructions, the JSON to write, the numbered hunks
semantic-zoom import review.json [folder]                                    # checks it against the code and saves it
```

The JSON holds `changes` (what the branch does: a few titled groups of its hunks, shown as the map's change cards and the panel's **What changed**) `findings` (bugs and risks, each with a severity, detail, evidence and the paths to fly to), `files` (for each changed file, what it is and what the branch did to it) and `folders` (for each folder above a changed file, what's kept in it, written from its files' opening comments, which the export lists). Rest the pointer on a file's or folder's name on the map to see them; a module's name shows its description from the architecture model. The import drops hunk ids that don't exist, lists hunks no change covers, drops paths that aren't on the map, and refuses a file written for an older commit of the branch. Descriptions go to `~/.semantic-zoom/descriptions/`, findings to `~/.semantic-zoom/reviews/`. The panel shows the findings first, under **AI review**, tinted and labelled AI-written so they never pass for the analyzer's checks, and shows a new review within a few seconds of its import, without moving the map or your selection.

From the terminal, `npm run analyze -- <repo> <branch> [base]` prints a branch's analysis and findings, with any saved descriptions.

The `/zoom-review` skill (`skills/zoom-review/SKILL.md`, linked into `~/.claude/skills/`) walks a Claude Code session through it: export, review, write, import.

## What changed

Claude groups the branch's source hunks into the handful of things the branch does, with a title and a sentence or two each. The code checks the result:

- Every source hunk must belong to a change. Any that don't are listed as **Not described**, on the map and in the panel, for you to read yourself.
- Hunk ids the model cites that don't exist are dropped and counted.

The descriptions say what changed, never whether it's good or fits the architecture. Fluent prose rounds off details, so the architecture findings come from the code, sit above the descriptions, and don't depend on them.

## Architecture

- **Module dependencies against the intended architecture** (a reflexion model, Murphy et al. 1995). `models/<repo>.json` lists the modules, which may depend on which, and which may not take third-party packages. Without a model file, modules are the top-level folders (and `crates/*`, `packages/*`, `apps/*`), and the base branch's dependencies count as the intended ones. If only tests crossed a forbidden line before, the first source import that crosses it is still a violation.
- **New cycles** between modules and between folders. Type-only imports don't count, since they're erased at compile time.
- **New third-party packages** and dependency changes in `package.json`.
- **Possible duplicates:** an exported name the branch adds that's already exported elsewhere in the same module.
- **Reach:** changed files with many unchanged direct importers.
- **Untested change:** a module with 3+ changed source files and no changed tests.

The footprint counts source files only. Tests, translations (`i18n/`, `locales/`, …) and generated files are counted separately.

Dependencies are found for TypeScript/JavaScript (imports, re-exports, `require`, dynamic `import()`, `new URL(…, import.meta.url)`, workspace package names and their `exports`) and Rust (`use` trees and inline `crate::`/`super::`/workspace-crate paths).

## The map

- By default it shows only the changed files (plus the target of any forbidden import, so a violation's arrow has both ends), laid out for reading: every file is a column of text, taller for a longer diff (by √rows, not in proportion), grouped by folder and module. Folders and columns then stretch to fill all the space, and the map takes the window's shape, so there's no blank around or between them. A box bigger than its diff fills with the unchanged lines around the change. Text is the same size in every box; a wider box just wraps later.
- The header's **Show** menu holds the view options, in two groups (Files; Highlight), and counts how many differ from the defaults. **Unchanged files** switches to the whole repo as a squarified treemap (module → folder → file, sized by √lines), with **Importers of changed files** tinting the files that import a change. **Tests** and **Translations** put those back in either view. Choices are remembered.
- A module whose files all sit in one folder is shown as that folder (`server/src` is just `server`).
- Zoomed out, numbered **change cards** sit over the code they describe. Hover one to outline its files, click to zoom to them. They fade as you zoom in, and step aside while you look at a change, finding or file.
- Arrows are kept for what a list can't show at a glance: a forbidden import (always drawn), a finding's edge, and the imports a change added or removed between its files when you click it. Selecting a file outlines what it imports (teal) and what imports it (purple) instead of drawing arrows.
- A box opens (shows its children) once it's 170 px on screen; arrows join the deepest open boxes, so they regroup as you zoom.
- Diff text is drawn on the GPU: MTSDF glyphs (Liberation Mono, OFL, from golemdocs' font atlases in `public/fonts/`), laid out off the main thread in a worker (`web/text/`), so a big PR stays smooth at any zoom.
- Labels are tags floating at each box's top-left corner (no space is kept for them, so boxes hold only their files), a fixed screen size, sliding along the window's edge when the corner is off screen. Module and folder tags fade out as diff text becomes readable, unless their box is mostly off screen. Diff text is drawn at every zoom, however small (zoomed out, the boxes are their text), GitHub-style (line numbers, hunk headers, buttons to show more lines around a change), and are built in idle time after a branch loads so zooming in doesn't stall.
- Select a file and the wheel over its text scrolls it (decided when the gesture starts); its text wraps at the window's edge, and can scroll so any line reaches the visible area.
- The breadcrumbs in the header say where the middle of the view is; click one to zoom to it.
- Double-click a box to read it: it zooms until the box fills the window's width, with its top at the window's top.
- Keys: `j`/`k` step through findings, `Esc` clears the selection (the view stays put; **Whole map** resets it).
