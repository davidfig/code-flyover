# Semantic Zoom

Code review on a map, for the human reviewer. See what a branch does and where it lands in the architecture from 1000 feet, then zoom through module → folder → file → diff.

The app helps you **understand** a change: what it does, where it sits, and whether that's where it belongs. It doesn't hunt for bugs. That's the AI review's job, and it happens in a Claude Code session, not here, so it has the full conversation, can read the code around the diff, ask questions, and carry across machines. The app's only AI use is the change descriptions.

The top level is a **difference, not a summary**: the branch's changes, described and pinned to the code they cover, over a map of the repo, with its new, removed and forbidden dependencies. The research behind this is in the vault: `Computer Science/AI Research/Semantic Zoom/Semantic Zoom Research Overview.md`.

## Use

```bash
npm install
npm run analyze -- ../golemdocs folder-sharing          # base defaults to origin/main
npm run dev
```

Analyzer options:

- `--no-describe`: skip the change descriptions (no API call).
- `--model <id>`: the model that writes them. Default `claude-sonnet-5-5`; `claude-haiku-5-5` is about 20× cheaper but groups less cleanly.
- `--redescribe`: write them again even if the head commit hasn't changed.

The descriptions call the Claude API with whatever credentials the SDK finds (`ANTHROPIC_API_KEY`, or an `ant auth login` profile). If none are there, the analysis still runs without descriptions. They cost about $0.10 a branch on Sonnet and are cached per head commit in `public/data/<repo>--<branch>.changes.json`.

The analyzer reads commits only (`git ls-tree`, `git cat-file`, `git diff`), so it never touches the repo's working tree. It writes `public/data/<repo>--<branch>.json` and adds the branch to `public/data/index.json`. `public/data/` is gitignored: it holds code from the analyzed repo.

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
- Arrows appear only when you ask: click a file or folder for its imports, or a finding for its edge. **All imports** shows every arrow.
- A box opens (shows its children) once it's 170 px on screen; arrows join the deepest open boxes, so they regroup as you zoom.
- Labels stay a fixed screen size and fade in; diffs fade in together as you zoom, GitHub-style (line numbers, hunk headers, buttons to show more lines around a change), and are built in idle time after a branch loads so zooming in doesn't stall.
- Select a file and the wheel over its text scrolls it (decided when the gesture starts); its text wraps at the window's edge, and can scroll so any line reaches the visible area.
- The breadcrumbs in the header say where the middle of the view is; click one to zoom to it.
- Double-click a box to read it: it zooms until the box fills the window's width, with its top at the window's top.
- Keys: `j`/`k` step through findings, `Esc` clears the selection (the view stays put; **Whole map** resets it).
