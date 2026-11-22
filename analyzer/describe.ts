// What a branch's change descriptions must be, and the check they pass, for the zoomed-out map.
//
// The app never calls a model. An outside AI (a Claude Code session, through `semantic-zoom export` and `import`,
// server/review-cli.ts) groups the branch's hunks into the distinct things it does and writes a title and a sentence
// for each. The descriptions are only as good as their coverage, so the code checks it: every source hunk must belong to
// a change, and anything left over is reported as "undescribed" rather than hidden. Hunk ids the AI invents are dropped
// and reported too. The descriptions say what changed, never whether it's good or fits the architecture; those are the
// analyzer's findings, which come from the code, not from prose.

import type { Analysis, Change, ChangeSet, FileInfo } from '../shared/types.ts'

/** The grouping rules, as `semantic-zoom export` gives them to the AI that writes the descriptions. */
export const SYSTEM = `You help a code reviewer see what a branch does before they read its diff.

You get the branch's commit messages and its source diff, split into hunks. Each hunk has an id like "path/to/file.ts#3".

Group the hunks into the distinct changes the branch makes: usually 3 to 8. A change is one thing the branch does (a feature, a fix, a refactor, a new endpoint), and it often spans several files and modules. Put every hunk id in exactly one change. If some hunks are small incidental edits that fit nowhere, collect them in one change titled "Small edits" and say what they are.

For each change:
- title: what it does, in plain words, at most 8 words, starting with a verb ("Adds shared-folder routes to the Worker").
- summary: one or two sentences on what changed in behaviour or structure, naming the main files or functions. Say only what the diff shows. Don't judge quality, don't say whether it fits the architecture, and don't guess at intent the diff doesn't show.
- hunks: the ids of its hunks, copied exactly.

Order the changes from most to least significant.`

/** The source files whose hunks must be described: changed, not tests, translations or generated. */
export function describable(a: Analysis): FileInfo[] {
  return a.files.filter((f) => f.status !== 'unchanged' && f.role === 'source' && f.hunks?.length)
}

export function renderDiff(a: Analysis): string {
  const out: string[] = []
  for (const f of describable(a)) {
    out.push(`=== ${f.path} (${f.status}${f.oldPath ? ` from ${f.oldPath}` : ''}, +${f.add} −${f.del})`)
    f.hunks!.forEach((h, i) => {
      out.push(`--- hunk ${f.path}#${i + 1}  ${h.header}`)
      for (const l of h.lines) out.push(l.t + l.s)
    })
  }
  return out.join('\n')
}

/** Every source hunk's id ("path#n"): what the descriptions must cover. */
export function hunkIds(a: Analysis): Set<string> {
  return new Set(describable(a).flatMap((f) => f.hunks!.map((_, i) => `${f.path}#${i + 1}`)))
}

/** The prompt's header: the branch, its commits and how many files it changes. */
export function branchSummary(a: Analysis): string {
  const files = describable(a)
  const muted = a.files.filter((f) => f.status !== 'unchanged' && f.role !== 'source').length
  return [
    `Repository: ${a.repo}. Branch ${a.head} against ${a.base}.`,
    '',
    'Commits (oldest first):',
    ...a.commits.map((c) => `- ${c.subject}`),
    '',
    `${files.length} source files changed${muted ? ` (${muted} test, translation or generated files also changed; not shown)` : ''}.`,
  ].join('\n')
}

/**
 * Checks descriptions against the code, as `semantic-zoom import` saves them: hunk ids that don't exist are dropped and listed, and hunks no change covers are listed.
 */
export function checkChanges(a: Analysis, changes: { title: string; summary: string; hunks: string[] }[], by: string): ChangeSet {
  const allIds = hunkIds(a)
  const invalid = new Set<string>()
  const used = new Set<string>()
  const items: Change[] = []
  for (const c of changes) {
    const hunks = [...new Set(c.hunks)].filter((h) => {
      if (!allIds.has(h)) { invalid.add(h); return false }
      if (used.has(h)) return false // first change that claims a hunk keeps it
      used.add(h)
      return true
    })
    if (hunks.length === 0) continue
    items.push({ title: c.title, summary: c.summary, hunks, files: [...new Set(hunks.map((h) => h.slice(0, h.lastIndexOf('#'))))] })
  }
  return {
    by,
    generatedAt: new Date().toISOString(),
    headSha: a.headSha,
    items,
    undescribed: [...allIds].filter((h) => !used.has(h)),
    invalid: [...invalid],
  }
}
