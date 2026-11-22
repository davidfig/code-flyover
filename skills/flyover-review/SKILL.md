---
name: flyover-review
description: Review the current branch (or a named one) and put the review on the Code Flyover map. Writes the change descriptions and the bug findings that the Code Flyover app shows, through `flyover export` and `import`. Use when the user says "/flyover-review", "review this branch for code flyover", or wants a review shown on the map.
---

# Review a branch for the Code Flyover map

Code Flyover is the user's code-review map. It shows two things an AI writes:

- **changes**: what the branch does, as 3 to 8 titled groups of diff hunks;
- **findings**: the bugs and risks you find, shown under "AI review", apart from the analyzer's architecture checks;
- **files**: two lines for each changed file (what it is, and what the branch did to it), shown on hovering its name;
- **folders**: a sentence for each folder above a changed file (what's kept in it), shown on hovering its name.

You write both into one JSON file and import it. The app shows it within a few seconds.

The command is `flyover` (on the PATH after Code Flyover's Install Claude Code Skill… menu item, or `npm link` in a checkout; in a checkout without it, run `node bin/flyover.mjs` from the checkout's folder).

## Steps

1. **Export.** In the repo, run `flyover export > <scratch file>`. It reviews the checked-out branch against the repo's default branch, with any uncommitted changes in its folder. If the user named a branch or base, add `--head <branch>` and `--base <ref>`. If the user named a different repo, pass its folder first.
2. **Read the export in full and follow it.** It holds the rules for all four parts (how to group and describe the changes, how to review and what a finding needs, how to describe each changed file and folder, with each folder's files and their opening comments to write from), the JSON to write, the analyzer's own findings, the architecture rules, the changed files and the source diff in numbered hunks. The rules live there, not here.
3. **Review the branch** as the export says, reading the repo beyond the diff where it matters.
4. **Write the JSON file** in your scratch folder, with all four parts. `by` is your model id and "via Claude Code".
5. **Import.** Run `flyover import <file>` in the repo (or pass the repo folder after the file). If it reports dropped hunk ids, uncovered hunks, unknown paths or undescribed files, fix the file and import again. If it says the branch moved, export again and redo the file.
6. **Report** to the user in a few lines: how many changes and findings, the most serious finding in one sentence, and that the app is already showing them.

Don't commit anything. The import writes only to `~/.code-flyover`. The files' "what it is" lines and the folder sentences also go into the repo's own notes, so other branches show them too; `/flyover-describe` covers the files no branch changed.
