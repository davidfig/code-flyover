# Semantic Zoom

Code review on a map. See where a branch lands in the architecture from 1000 feet, then zoom through module → folder → file → diff.

The top level is a **difference, not a summary**: the branch's footprint and its new, removed and forbidden dependencies drawn over a map of the repo that stays the same from one branch to the next. The research behind this is in the vault: `Computer Science/AI Research/Semantic Zoom/Semantic Zoom Research Overview.md`.

## Use

```bash
npm install
npm run analyze -- ../golemdocs folder-sharing          # base defaults to origin/main
npm run analyze -- ../satchel-mail fix-release-checks
npm run dev
```

The analyzer reads commits only (`git ls-tree`, `git cat-file`, `git diff`), so it never touches the repo's working tree. It writes `public/data/<repo>--<branch>.json` and adds the branch to `public/data/index.json`.

## What it checks

- **Module dependencies against the intended architecture** (a reflexion model, Murphy et al. 1995). `models/<repo>.json` lists the modules, which may depend on which, and which may not take third-party packages. Without a model file, modules are the top-level folders (and `crates/*`, `packages/*`, `apps/*`), and the base branch's dependencies count as the intended ones.
- **New cycles** between modules and between folders. Type-only imports don't count, since they're erased at compile time.
- **New third-party packages** and dependency changes in `package.json`.
- **Possible duplicates:** an exported name the branch adds that's already exported elsewhere in the same module.
- **Reach:** changed files with many unchanged direct importers.
- **Untested change:** a module with 3+ changed source files and no changed tests.

Dependencies are found for TypeScript/JavaScript (imports, re-exports, `require`, dynamic `import()`, `new URL(…, import.meta.url)`, workspace package names and their `exports`) and Rust (`use` trees and inline `crate::`/`super::`/workspace-crate paths).

## The map

- Squarified treemap: module → folder → file, sized by √lines so big files don't swamp the view. The layout depends only on structure, so it's stable across branches.
- A box opens (shows its children) once it's 170 px on screen; arrows join the deepest open boxes, so they regroup as you zoom.
- Labels stay a fixed screen size; diffs appear inside a file once it's 300 px wide.
- Keys: `j`/`k` step through findings, double-click zooms to a box, `Esc` shows the whole map.
