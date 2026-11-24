# Code Flyover

Code review on a map. See what a branch does and where it lands in your architecture from 1000 feet, then zoom through module → folder → file → diff without leaving the picture.

<!-- Screenshot: add docs/screenshot.png and uncomment.
![A branch on the Code Flyover map](docs/screenshot.png)
-->

Most review tools give you a list of files. Code Flyover gives you a map of the repo with the branch's changes laid over it:

- **What changed, pinned to the code.** The branch's hunks are grouped into a handful of described changes, shown as numbered cards over the files they touch. Hunks no description covers are flagged for you to read yourself.
- **Where it lands.** New, removed and forbidden dependencies between modules, new cycles, new third-party packages, likely duplicates, and changed files with many importers, all checked from the code rather than written by a model.
- **The diff itself.** Zoom in and every box is its diff, drawn on the GPU, so a large branch stays smooth at any zoom.

It's built to help a person **understand** a change: what it does, where it sits, and whether that's where it belongs. Bug hunting is left to an AI reviewer you run separately (see [AI review](#ai-review)), whose findings then show up on the map.

Everything runs on your machine. The app reads your repo through git, never touches your working tree, and never calls a model or sends code anywhere.

## Requirements

- Node.js 20.19+ or 22.12+
- git
- For the desktop app: Node.js and git on the machine (the installers don't include them). To build it yourself you also need Rust and the Tauri CLI (`cargo install tauri-cli`); on Linux, Tauri's [system packages](https://v2.tauri.app/start/prerequisites/#linux) (`libwebkit2gtk-4.1-dev` and friends).
- The browser version works wherever Node does. The desktop app is built for macOS, Windows and Linux, but has only been tried on macOS so far.

## Install

```bash
git clone https://github.com/davidfig/code-flyover.git
cd code-flyover
npm install
npm link        # puts the `flyover` command on your PATH
```

## Quick start

In any git repo:

```bash
flyover
```

This adds the repo to the app's list, starts the app's server on http://localhost:5197 if it isn't running, and opens it in your browser. You can also pass a folder: `flyover ~/code/my-project`. Ctrl-C in that terminal stops the server.

Then:

1. **Pick a branch** in the header. Branches are listed newest first, with how far ahead of the base they are. Its map is built on the spot, usually in about a second.
2. **Pick the base** under **compared with** in the side panel. The default is the remote's default branch, such as `origin/main`.
3. **Fly around.** Hover a change card to outline its files, and click it to zoom there. Double-click any box to read it full width. Press `j`/`k` to step through findings and `Esc` to clear the selection. **Fit** resets the view, and **Changes | Whole repo** (or `U`) switches between the files the branch changes and the whole repo. The **Show** list picks which kinds of files are on the map: **Code** and **Docs** (Markdown and text) to start with, plus **Tests** and **Translations** (keys `C`, `D`, `T`, `L`).

A branch checked out in a worktree with uncommitted changes is shown with those changes included. The map stays live: when the branch, its uncommitted files or its base change, it's rebuilt within a few seconds.

The header's **Show** menu switches between just the changed files (the default) and the whole repo as a treemap, and can bring tests and translation files back in.

## Architecture checks

Without any setup, each top-level folder (and each package under `packages/`, `crates/`, `apps/` and so on) is a module, and the base branch's dependencies count as the allowed ones. Anything the branch adds is checked against that.

To check against the architecture you intend instead, add a `.code-flyover.json` at the root of your repo:

```json
{
  "name": "My project",
  "source": "docs/architecture.md",
  "modules": [
    { "id": "core", "paths": ["src/core/"], "description": "Domain model, no I/O" },
    { "id": "api", "paths": ["src/api/"], "description": "HTTP handlers" },
    { "id": "web", "paths": ["web/"], "description": "The front end" }
  ],
  "allowed": { "core": [], "api": ["core"], "web": ["core"] },
  "noThirdParty": ["core"],
  "rules": ["Dependencies point inward: core never imports api or web."]
}
```

- `allowed` lists which modules each module may import.
- `noThirdParty` lists modules whose source may not import npm or Cargo packages.
- `rules` are shown with the model as plain-text reminders.

The file is read from the **base** commit, so a branch can't loosen the rules it's checked against. A branch that edits the file gets a warning.

Dependencies are found for TypeScript/JavaScript (and Vue, Svelte and Astro scripts), Rust, Python, Go, C#, Java, Kotlin, Scala, Swift, PHP, Ruby, C/C++/Objective-C, Dart and Lua. Every other text file (config, styles, HTML, shell scripts, languages without a dependency finder yet) is still on the map, coloured where the language is known, and linked to the repo files it names in quotes.

## AI review

The app doesn't call a model and needs no API key. The change descriptions and the bug-hunting review are written by an AI agent you run yourself, which hands its work to the app through two commands:

```bash
flyover export [folder] [--head <branch>] [--base <ref>] > input.md
flyover import review.json [folder]
```

`export` prints everything the reviewer needs: instructions, the JSON format to write, and the branch's numbered hunks. `import` checks the JSON against the code and saves it. It drops hunk ids that don't exist, lists hunks no change covers, and refuses a review written for an older commit. The app shows the new review within a few seconds, labelled as AI-written so it never passes for the analyzer's own checks.

### With Claude Code

A ready-made [Claude Code](https://claude.com/claude-code) skill walks a session through export, review and import. In the desktop app, choose **Install Claude Code Skill…** (in the Code Flyover menu on macOS, File on Windows and Linux). It installs the app's skills (`/flyover-review`, `/flyover-describe`) in `~/.claude/skills/`, and a `flyover` command that runs the app's own copy (`~/.local/bin/flyover` on macOS and Linux; on Windows `~/.code-flyover/bin/flyover.cmd`, added to your PATH). Run it again after updating the app. From a checkout, link the skill in once instead:

```bash
ln -s "$PWD/skills/flyover-review" ~/.claude/skills/flyover-review
```

Then, in a Claude Code session in the repo you're reviewing, run `/flyover-review`.

### Notes on every file and folder

A review describes only the files the branch changes. To put a note on every source file and folder in the repo, shown on hovering its name in any branch, run:

```bash
flyover describe [folder] [--under <dir>] [--batch <n>]
```

It prints the next batch of files and folders with no current note, with what to write, and `flyover import` saves the JSON. The notes belong to the repo, not a branch: each is tied to the file's contents (a folder's to its list of files) and marked out of date when that changes, so running it again only redoes what changed. A review's own "what it is" lines go into the same notes. The `flyover-describe` skill runs the batches for you; link it like the review skill:

```bash
ln -s "$PWD/skills/flyover-describe" ~/.claude/skills/flyover-describe
```

### With another agent

Any agent that can run shell commands works: have it run `flyover export`, follow the instructions in the output, and run `flyover import` on the JSON it writes. [`skills/flyover-review/SKILL.md`](skills/flyover-review/SKILL.md) has the steps in plain prose, which you can reuse as a prompt.

## Desktop app

`src-tauri/` wraps the same app in a window of its own (built with Tauri), with a menu bar and File › Open Repo… using the system folder picker. It runs on macOS, Windows and Linux (the Windows and Linux builds are untested so far).

**Download:** installers (macOS `.dmg`, Windows `.msi` / `.exe`, Linux `.deb`, `.rpm` and `.AppImage`) are attached to each [GitHub release](https://github.com/davidfig/code-flyover/releases). They're unsigned, so macOS and Windows will warn the first time you open one. You need Node.js and git installed.

**Updates:** the downloaded app keeps itself up to date (on Linux, the AppImage; `.deb` and `.rpm` installs update with a new download). It checks for a new release at start and every six hours, downloads it in the background, then offers **Restart to update**; nothing installs until you click it. **Check for Updates…** (in the Code Flyover menu on macOS, Help on Windows and Linux) checks now. Updates are signed, and the app refuses any that the project's update key didn't sign. A copy you build yourself doesn't update itself.

**Build it yourself:**

```bash
node src-tauri/stage-app.mjs      # copies the server and Vite into src-tauri/app, to bundle in the installer
cd src-tauri
cargo tauri build --config tauri.bundle.conf.json
# → src-tauri/target/release/bundle/ (macOS: macos/Code Flyover.app and dmg/; Windows: msi/ and nsis/; Linux: deb/, rpm/, appimage/)
```

Without the first step and `--config`, `cargo tauri build` makes an app that runs the server from the checkout it was built in (rebuild it if you move the folder), which is fine for yourself.

On launch the app uses a server already running on port 5197, or starts one. On macOS and Linux that goes through your login shell, so `node` and `git` are found as they are in your terminal; on Windows `node` is looked up on the PATH (the Node.js and git installers add themselves to it; restart the app after installing). If the server can't start, the window shows its output. Its log is `~/.code-flyover/app-server.log`.

**Releasing:** push a tag such as `v0.1.0` (matching `version` in `src-tauri/tauri.conf.json`). The workflow in `.github/workflows/release.yml` builds every platform and attaches the installers to a draft release, with the signed update bundles and the `latest.json` the apps read. Installed apps only see a release once you publish the draft, so check it first. The build needs the update key in the `TAURI_SIGNING_PRIVATE_KEY` repository secret, and fails a tag whose version doesn't match the config (the feed would otherwise offer apps an update to themselves forever). To pull a bad release, move it back to draft and release a fix with a higher version; apps never downgrade.

## Your data

The app keeps its state in `~/.code-flyover/`: the list of repos, your settings, and saved change descriptions and AI reviews. Repos are only ever read (`git ls-tree`, `git cat-file`, `git diff`). Uncommitted changes are read through a temporary index of the app's own, so your folder, index and branches are never touched.

## Development

```bash
npm run dev          # the same app on http://localhost:5196, with hot reload
npm run typecheck
npm run analyze -- <repo> <branch> [base]   # print a branch's analysis in the terminal
```

There's no build step: the server is Vite with a small API (`vite.config.ts`, `server/api.ts`), and what's in the checkout is what runs.

| Folder | What's in it |
|---|---|
| `analyzer/` | Reads git, finds dependencies, runs the architecture checks |
| `server/` | The API, the `export`/`describe`/`import` commands and the repo's notes |
| `web/` | The map: layout, WebGL rendering, GPU text (`web/text/`), the side panel |
| `shared/` | Types shared by the server and the page |
| `src-tauri/` | The desktop app |
| `skills/` | The Claude Code skills |

[docs/design.md](docs/design.md) explains how the map, the checks and the descriptions work, and why.

## License

MIT, see [LICENSE](LICENSE). The bundled Liberation Mono font is under the SIL Open Font License ([`public/fonts/liberation-mono/LICENSE.txt`](public/fonts/liberation-mono/LICENSE.txt)).
