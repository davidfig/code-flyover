---
name: zoom-review
description: Review the current branch (or a named one) and put the review on the Semantic Zoom map. Writes the change descriptions and the bug findings that the Semantic Zoom app shows, through `semantic-zoom export` and `import`. Use when the user says "/zoom-review", "review this branch for semantic zoom", or wants a review shown on the map.
---

# Review a branch for the Semantic Zoom map

Semantic Zoom (`~/Programming/semantic-zoom`) is the user's code-review map. It shows two things an AI writes:

- **changes**: what the branch does, as 3 to 8 titled groups of diff hunks;
- **findings**: the bugs and risks you find, shown under "AI review", apart from the analyzer's architecture checks.

You write both into one JSON file and import it. The app shows it the next time its window comes forward.

The command is `node ~/Programming/semantic-zoom/bin/semantic-zoom.mjs` (shortened to `semantic-zoom` below; use the full form unless `semantic-zoom` is on the PATH).

## Steps

1. **Export.** In the repo, run `semantic-zoom export > <scratch file>`. It reviews the checked-out branch against the repo's default branch. If the user named a branch or base, add `--head <branch>` and `--base <ref>`. If the user named a different repo, pass its folder first.
2. **Read the export in full.** It has the instructions, the JSON to write, the analyzer's own findings (don't repeat them), the architecture rules, the changed files, and the source diff in numbered hunks.
3. **Review the branch for real.** Read beyond the diff where it matters: callers of changed functions, the tests, the code a change relies on. Look for bugs: wrong behaviour, missed cases, crashes, races, lost data, security holes, broken contracts with callers. Every finding needs evidence from the code. Leave out style. Don't invent findings to fill the list; an empty list is a fine answer.
4. **Write the JSON file** in your scratch folder, exactly as the export describes. Copy `head`, `base` and `headSha` from the export. Put every hunk id in exactly one change. `by` is your model id and "via Claude Code".
5. **Import.** Run `semantic-zoom import <file>` in the repo (or pass the repo folder after the file). If it reports dropped hunk ids, uncovered hunks or unknown paths, fix the file and import again. If it says the branch moved, export again and redo the file.
6. **Report** to the user in a few lines: how many changes and findings, the most serious finding in one sentence, and that the app will show them when they switch back to it.

Don't commit anything. The import writes only to `~/.semantic-zoom`.
