# How Code Flyover works

The details behind the [README](../README.md): what each part of the map shows, how the checks work, and why it's built this way.

## The idea

The top level is a **difference, not a summary**. It shows the branch's changes, described and pinned to the code they cover, over a map of the repo with its new, removed and forbidden dependencies. A summary tells you what the code is; a reviewer needs to know what the branch did to it.

The app helps you understand a change. It doesn't hunt for bugs: that's the AI review's job, and it runs in an agent session outside the app, where it has the whole conversation, can read the code around the diff, can ask questions, and carries across machines. The app itself never calls a model.

## What changed

An outside AI groups the branch's source hunks into the handful of things the branch does, with a title and a sentence or two each (`flyover export` gives it the rules, `analyzer/describe.ts`). The code checks the result:

- Every source hunk must belong to a change. Any that don't are listed as **Not described**, on the map and in the panel, for you to read yourself.
- Hunk ids that don't exist are dropped and counted.

The descriptions say what changed, never whether it's good or fits the architecture. Fluent prose rounds off details, so the architecture findings come from the code, sit above the descriptions, and don't depend on them.

The same review file can also hold `files` (for each changed file, what it is and what the branch did to it) and `folders` (for each folder above a changed file, what's kept in it). They're shown when you rest the pointer on a file's or folder's name. A module's name shows its description from the architecture model.

## Architecture checks

- **Module dependencies against the intended architecture**, a reflexion model (Murphy, Notkin and Sullivan, 1995). The model lists the modules, which may depend on which, and which may not take third-party packages. It's read from `.code-flyover.json` at the repo's root at the base commit, then from `models/<repo name>.json` in this checkout, and failing both it's inferred: modules are the top-level folders (and `crates/*`, `packages/*`, `apps/*`, `libs/*`, `services/*`), and the base branch's dependencies count as intended. If only tests crossed a forbidden line before, the first source import that crosses it is still a violation.
- **New cycles** between modules and between folders. Type-only imports don't count, since they're erased at compile time.
- **New third-party packages** and dependency changes in `package.json`.
- **Possible duplicates:** an exported name the branch adds that's already exported elsewhere in the same module.
- **Reach:** changed files with many unchanged direct importers.
- **Untested change:** a module with 3+ changed source files and no changed tests.

The footprint counts source files only. Tests, translations (`i18n/`, `locales/`, …) and generated files are counted separately.

Dependencies are found by language (the list of languages and their file extensions is `shared/languages.ts`):

- **TypeScript/JavaScript**, and the scripts in Vue, Svelte and Astro files: imports, re-exports, `require`, dynamic `import()`, `new URL(…, import.meta.url)`, workspace package names and their `exports`.
- **Rust:** `use` trees and inline `crate::`/`super::`/workspace-crate paths.
- **Python:** `import` and `from … import`, relative ones included, resolved to modules and packages' `__init__.py` under any folder that could be on the importer's `sys.path`. Imports from outside the repo and the standard library are third-party packages.
- **Go:** imports under a `go.mod` module, to the files in that package that declare the names used (`pkg.Name`); files in one package depend on the siblings whose names they use.
- **C#, Java, Kotlin, Scala, Swift, PHP, Ruby:** by name. A file depends on another when it uses a name the other declares in a scope it can see: its own namespace, package or module (C# adds the parent namespaces), the ones it imports whole, and the names it imports one by one. Ruby's constants are global, as Rails autoloads them. It's names, not types, so a variable that shares a class's name counts too.
- **C/C++/Objective-C** `#include`/`#import`, **Dart** `import`/`export`/`part` (with `package:` paths for packages in the repo), **Lua** `require`, plus Ruby's `require`/`require_relative` and PHP's `require`/`include`: by path.
- **Everything else** that's text is on the map as the fallback (binaries, build output and files over 512 KB aren't): it's diffed and coloured like code (as plain text if the language isn't listed), and depends on the repo files it names in quotes or `url(…)`, outside comments, relative to the file or the repo root.

Lockfiles count as generated. Only programming languages count toward the "no tests changed" finding, so a branch that changes three config files isn't asked for tests.

## The map

- By default it shows only the changed files (plus the target of any forbidden import, so a violation's arrow has both ends), laid out for reading: every file is a column of text, taller for a longer diff (by √rows, not in proportion), grouped by folder and module. They're packed as tightly as it can find for the window's shape, so every box is as big as possible with the whole map in view; folders and columns then stretch a little to fill what's left. A box bigger than its diff fills with the unchanged lines around the change. Text is the same size in every box; a wider box just wraps later.
- **Show › Unchanged files** switches to the whole repo as a squarified treemap (module → folder → file, sized by √lines), and **Importers of changed files** tints the files that import a change. **Tests** and **Translations** put those back in either view.
- A module whose files all sit in one folder is shown as that folder (`server/src` is just `server`).
- Zoomed out, numbered **change cards** sit over the code they describe. They fade as you zoom in, and step aside while you look at a change, finding or file.
- Arrows are kept for what a list can't show at a glance: a forbidden import (always drawn), a finding's edge, and the imports a change added or removed between its files when you click it. Selecting a file outlines what it imports (teal) and what imports it (purple) instead of drawing arrows.
- A box opens (shows its children) once it's 170 px on screen; arrows join the deepest open boxes, so they regroup as you zoom.
- Diff text is drawn on the GPU with MTSDF glyphs (Liberation Mono, in `public/fonts/`), laid out off the main thread in a worker (`web/text/`), so a big branch stays smooth at any zoom. It's drawn GitHub-style (line numbers, hunk headers, buttons to show more lines around a change) and built in idle time after a branch loads, so zooming in doesn't stall.
- Labels are tags floating at each box's top-left corner, a fixed screen size, sliding along the window's edge when the corner is off screen. Module and folder tags fade out as diff text becomes readable, unless their box is mostly off screen.
- Select a file and the wheel over its text scrolls it (decided when the gesture starts). Its text wraps at the window's edge and can scroll so any line reaches the visible area.
- The breadcrumbs in the header say where the middle of the view is; click one to zoom to it.

## Reading uncommitted changes

A branch checked out in a folder with uncommitted changes (say, an AI agent's worktree) is shown with them. The map reads a snapshot of that folder's files, made through a temporary index of its own, so the folder, its index and its branches are never touched. The snapshot's objects stay in the repo's object store until `git gc`. The branch picker marks such branches "uncommitted changes".

## State

Everything the app keeps is in `~/.code-flyover/`: `repos.json`, `settings.json`, `descriptions/<repo id>/<head>..<base>.json`, `reviews/<repo id>/<head>..<base>.json`, and `app-server.log` from the desktop app.

The app was called Semantic Zoom until November 2026. On first start it moves `~/.semantic-zoom/` to `~/.code-flyover/`, and a repo's `.semantic-zoom.json` is still read when there's no `.code-flyover.json`.

## Desktop app

The icon is drawn by `src-tauri/icon.mjs`; `src-tauri/icon.sh` remakes the icon files. The app stops the server it started when you quit, and writes that server's output to `~/.code-flyover/app-server.log`.
