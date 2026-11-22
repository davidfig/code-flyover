// What a branch's change descriptions must be, and the check they pass, for the zoomed-out map.
//
// The app never calls a model. An outside AI (a Claude Code session, through `flyover export` and `import`,
// server/review-cli.ts) groups the branch's hunks into the distinct things it does and writes a title and a sentence
// for each. The descriptions are only as good as their coverage, so the code checks it: every source hunk must belong to
// a change, and anything left over is reported as "undescribed" rather than hidden. Hunk ids the AI invents are dropped
// and reported too. The descriptions say what changed, never whether it's good or fits the architecture; those are the
// analyzer's findings, which come from the code, not from prose.

import type { Analysis, Change, ChangeSet, FileInfo } from '../shared/types.ts'

/** How to write the change descriptions: the rules `flyover export` gives the AI that writes them. */
export const CHANGE_RULES = `The changes say what the branch does, so the reviewer knows what they're looking at before reading the code. Each one shows as a numbered card over its files on the zoomed-out map, and in the panel under "What changed".

Group the hunks below into the distinct things the branch does: usually 3 to 8. A change is one thing (a feature, a fix, a refactor, a new endpoint), and it often spans several files and modules. Put every hunk id in exactly one change: a hunk left out shows as "Not described", for the reviewer to read unaided. Small incidental edits that fit nowhere go in one change titled "Small edits", which says what they are.

For each change:
- title: what it does, in plain words, at most 8 words, starting with a verb ("Adds shared-folder routes to the Worker").
- summary: one or two sentences on what changed in behaviour or structure, naming the main files or functions. Describe only: no judgement of quality, nothing on whether it fits the architecture (findings are for that), and no guessing at intent the code doesn't show.
- hunks: the ids of its hunks, copied exactly from the diff below ("path/to/file.ts#3").

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
 * Checks descriptions against the code, as `flyover import` saves them: hunk ids that don't exist are dropped and listed, and hunks no change covers are listed.
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
