---
name: flyover-describe
description: Describe a whole repo for the Code Flyover map. Writes a sentence for every source file and folder (what it is), shown on hovering its name on the map on any branch, through `flyover describe` and `import`. Notes are tied to file contents, so a rerun only redoes what changed. Use when the user says "/flyover-describe", "describe this repo for code flyover", or wants tooltips on unchanged files.
---

# Describe a repo for the Code Flyover map

Code Flyover is the user's code-review map. Hovering a file's or folder's name on it shows what that file or folder is. `/flyover-review` writes those notes only for the files a branch changes; this skill writes them for the rest of the repo.

The notes are the repo's, not a branch's. Each is tied to the file's contents (a folder's to its list of files), so it shows on every branch where the file is the same, and it's marked out of date once the file changes. Running this skill again only redoes the files and folders that changed since.

The command is `flyover` (on the PATH after Code Flyover's Install Claude Code Skill… menu item, or `npm link` in a checkout; in a checkout without it, run `node bin/flyover.mjs` from the checkout's folder).

## Steps

1. **See how much there is.** In the repo, run `flyover describe > <scratch file>` and read its first lines: how many files and folders already have a current note, and how many are left. If the user named a folder, add `--under <folder>`. If they named another repo, pass its folder first.
2. **Check the size with the user** when more than about 150 files are left and they didn't already say to do the whole repo: tell them the count and offer to do one folder first (`--under`). A batch costs about as much as reading its 40 files.
3. **Describe in batches.** For each batch, start a subagent (Agent tool, `model: "sonnet"`; writing these sentences is summarizing, which doesn't need a bigger model) with this brief: run `flyover describe` (with the same folder and `--under` options) into a scratch file, read the output in full and follow it, write the JSON file it asks for, run `flyover import <file>` in the repo, fix and re-import if it skipped anything it shouldn't have, and report the import's last lines. Run the batches one after another: each `describe` picks up where the last import left off. Stop when the import says every file and folder has a current note, or when a batch makes no progress (report what it skipped instead of looping).
4. **Check one batch's work yourself** after the first: open two or three of the files it described and see that the sentences say what the files do. If they're guesses from file names, tighten the brief before the next batch.
5. **Report** in a few lines: how many files and folders now have notes, anything left out and why, and that the app is already showing them (rest the pointer on a file's or folder's name, or click it; **Whole repo** shows the unchanged files).

Don't commit anything. The import writes only to `~/.code-flyover/notes/`.
