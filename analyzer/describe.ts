// Describes what a branch does, as a handful of changes, for the zoomed-out map.
//
// Claude groups the branch's hunks into the distinct things it does and writes a title and a sentence for each.
// The descriptions are only as good as their coverage, so the code checks it: every source hunk must belong to a
// change, and anything left over is reported as "undescribed" rather than hidden. Hunk ids the model invents are
// dropped and reported too. The descriptions say what changed, never whether it's good or fits the architecture;
// those are the analyzer's findings, which come from the code, not from prose.

import Anthropic from '@anthropic-ai/sdk'
import { DESCRIBE_MODEL, type Analysis, type Change, type ChangeSet, type FileInfo } from '../shared/types.ts'

/** Grouping hunks and writing a sentence each is light work: a smaller model does it (pick another with --model). */
export const DEFAULT_MODEL = DESCRIBE_MODEL

const SYSTEM = `You help a code reviewer see what a branch does before they read its diff.

You get the branch's commit messages and its source diff, split into hunks. Each hunk has an id like "path/to/file.ts#3".

Group the hunks into the distinct changes the branch makes: usually 3 to 8. A change is one thing the branch does (a feature, a fix, a refactor, a new endpoint), and it often spans several files and modules. Put every hunk id in exactly one change. If some hunks are small incidental edits that fit nowhere, collect them in one change titled "Small edits" and say what they are.

For each change:
- title: what it does, in plain words, at most 8 words, starting with a verb ("Adds shared-folder routes to the Worker").
- summary: one or two sentences on what changed in behaviour or structure, naming the main files or functions. Say only what the diff shows. Don't judge quality, don't say whether it fits the architecture, and don't guess at intent the diff doesn't show.
- hunks: the ids of its hunks, copied exactly.

Order the changes from most to least significant.`

const SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          hunks: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'summary', 'hunks'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes'],
  additionalProperties: false,
} as const

/** The source files whose hunks must be described: changed, not tests, translations or generated. */
function describable(a: Analysis): FileInfo[] {
  return a.files.filter((f) => f.status !== 'unchanged' && f.role === 'source' && f.hunks?.length)
}

function renderDiff(a: Analysis): string {
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

export async function describeChanges(a: Analysis, model = DEFAULT_MODEL): Promise<ChangeSet> {
  const files = describable(a)
  const allIds = new Set(files.flatMap((f) => f.hunks!.map((_, i) => `${f.path}#${i + 1}`)))
  const muted = a.files.filter((f) => f.status !== 'unchanged' && f.role !== 'source').length

  const prompt = [
    `Repository: ${a.repo}. Branch ${a.head} against ${a.base}.`,
    '',
    'Commits (oldest first):',
    ...a.commits.map((c) => `- ${c.subject}`),
    '',
    `${files.length} source files changed${muted ? ` (${muted} test, translation or generated files also changed; not shown)` : ''}.`,
    '',
    renderDiff(a),
  ].join('\n')

  const client = new Anthropic()
  const response = await client.beta.messages
    .stream({
      model,
      max_tokens: 32000,
      // If a safety classifier declines, the API retries on a fallback model in the same call (Haiku has none).
      ...(model.includes('haiku') ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })
    .finalMessage()

  if (response.stop_reason === 'refusal') throw new Error(`Claude declined to describe the branch (${response.stop_details?.category ?? 'no category'})`)
  if (response.stop_reason === 'max_tokens') throw new Error('The description was cut off (max_tokens)')
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  const parsed = JSON.parse(text) as { changes: { title: string; summary: string; hunks: string[] }[] }

  // Coverage: the descriptions must account for the code.
  const invalid = new Set<string>()
  const used = new Set<string>()
  const items: Change[] = []
  for (const c of parsed.changes) {
    const hunks = [...new Set(c.hunks)].filter((h) => {
      if (!allIds.has(h)) { invalid.add(h); return false }
      if (used.has(h)) return false // first change that claims a hunk keeps it
      used.add(h)
      return true
    })
    if (hunks.length === 0) continue
    items.push({ title: c.title, summary: c.summary, hunks, files: [...new Set(hunks.map((h) => h.slice(0, h.lastIndexOf('#'))))] })
  }
  const undescribed = [...allIds].filter((h) => !used.has(h))

  return {
    by: response.model,
    generatedAt: new Date().toISOString(),
    headSha: a.headSha,
    items,
    undescribed,
    invalid: [...invalid],
  }
}
