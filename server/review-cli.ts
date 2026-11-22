// Lets an outside AI (a Claude Code session, say) write what the app shows: the change descriptions and a review.
//
// semantic-zoom export [folder] [--head <branch>] [--base <ref>]
//   Prints what the AI needs: the instructions, the JSON to write, the branch's numbered hunks and the paths it may
//   point at. The head defaults to the folder's checked-out branch, the base to the repo's default branch.
// semantic-zoom import <file.json> [folder]
//   Checks that file against the code (hunk ids, coverage, paths, the head commit) and saves it where the app looks
//   (~/.semantic-zoom, server/api.ts). The app shows it the next time its window comes forward.
//
// Run through bin/semantic-zoom.mjs, which hands these two commands to tsx.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { branchSummary, checkChanges, describable, renderDiff, SYSTEM } from '../analyzer/describe.ts'
import { addRepo, analysisFor, defaultBase, saveDescriptions, saveReview } from './api.ts'
import type { Analysis, Finding, Review, Severity } from '../shared/types.ts'

/** What the AI writes (and `import` reads). */
interface ReviewFile {
  by: string
  head: string
  base: string
  headSha: string
  changes?: { title: string; summary: string; hunks: string[] }[]
  findings?: { severity: Severity; title: string; detail?: string; evidence?: string[]; paths?: string[] }[]
}

const SEVERITIES: Severity[] = ['violation', 'warning', 'info']

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  if (!value) fail(`${name} needs a value`)
  return value
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const currentBranch = (folder: string) => {
  try {
    const b = execFileSync('git', ['-C', folder, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return b || undefined
  } catch {
    return undefined
  }
}

function load(folder: string, head: string, base: string): Analysis {
  try {
    return analysisFor(addRepo(folder), head, base)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

function exportInput() {
  const headOpt = option('--head')
  const baseOpt = option('--base')
  const folder = path.resolve(args[0] ?? process.cwd())
  const head = headOpt ?? currentBranch(folder) ?? fail(`${folder} has no branch checked out: name one with --head`)
  const repo = addRepo(folder)
  const base = baseOpt ?? defaultBase(repo.path)
  const a = load(folder, head, base)
  const changed = a.files.filter((f) => f.status !== 'unchanged')
  const template: ReviewFile = {
    by: '<your model id> via <where you ran>, e.g. claude-opus-5-5 via Claude Code',
    head,
    base,
    headSha: a.headSha,
    changes: [{ title: 'Adds …', summary: '…', hunks: [describable(a)[0]?.hunks?.length ? `${describable(a)[0].path}#1` : 'path/to/file.ts#1'] }],
    findings: [{ severity: 'warning', title: '…', detail: '…', evidence: ['path/to/file.ts:42  the line in question'], paths: ['path/to/file.ts'] }],
  }
  const out = [
    `# Semantic Zoom: review input for ${a.repo}, ${head} against ${base}`,
    '',
    `Head commit ${a.headSha}. Write one JSON file, then run \`semantic-zoom import <file>\` in the repo (or pass the repo's folder after the file).`,
    'The import checks the file against this commit and tells you what it dropped; fix the file and import again until it reports nothing dropped.',
    '',
    '## The file to write',
    '',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
    '',
    'Copy head, base and headSha exactly. Both `changes` and `findings` are optional: leave one out to keep what the app has.',
    '',
    '## changes: what the branch does',
    '',
    'Follow these rules:',
    '',
    SYSTEM,
    '',
    '## findings: your review',
    '',
    'Bugs and risks you found in the branch, most important first. Each one is shown in the app\'s panel under "AI review", apart from the analyzer\'s architecture findings, and clicking it flies the map to its paths.',
    '',
    '- severity: "violation" for a bug (wrong behaviour, a crash, lost data, a security hole), "warning" for something to check (risky, unclear, untested), "info" for a note.',
    '- title: the problem in at most 10 words.',
    '- detail: one to three sentences: what goes wrong and when. Say how sure you are when you are not.',
    '- evidence: the lines that show it, as "path:line  code".',
    '- paths: the files (or folders) to look at, from the list below. Paths not on the map are dropped from the target.',
    '- Leave out style preferences and anything the analyzer already reports (below).',
    '',
    '## The analyzer\'s own findings (don\'t repeat them)',
    '',
    ...(a.findings.length ? a.findings.map((f) => `- [${f.severity}] ${f.title}${f.detail ? `: ${f.detail}` : ''}`) : ['- none']),
    '',
    `## Architecture: ${a.model.name} (${a.model.kind})`,
    '',
    ...(a.model.rules.length ? a.model.rules.map((r) => `- ${r}`) : ['- no rules']),
    '',
    '## The branch',
    '',
    branchSummary(a),
    '',
    'Changed files on the map (paths you can use in findings; any folder above them works too):',
    '',
    ...changed.map((f) => `- ${f.path} (${f.status}, ${f.role}, +${f.add} −${f.del})`),
    ...(a.otherChanges.length ? ['', 'Also changed, but not on the map (docs, assets, locales):', '', ...a.otherChanges.map((o) => `- ${o.path}`)] : []),
    '',
    '## The source diff, in numbered hunks',
    '',
    'Tests, translations and generated files are left out of the hunks; read them with git if your review needs them.',
    '',
    '```diff',
    renderDiff(a),
    '```',
  ]
  process.stdout.write(out.join('\n') + '\n')
}

function importReview() {
  const [fileArg, folderArg] = args
  if (!fileArg) fail('usage: semantic-zoom import <file.json> [repo folder]')
  let file: ReviewFile
  try {
    file = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'))
  } catch (e) {
    fail(`Couldn't read ${fileArg}: ${e instanceof Error ? e.message : e}`)
  }
  for (const k of ['by', 'head', 'base', 'headSha'] as const) if (typeof file[k] !== 'string' || !file[k]) fail(`${fileArg} needs "${k}" (copy it from \`semantic-zoom export\`)`)
  if (!file.changes && !file.findings) fail(`${fileArg} has neither "changes" nor "findings"`)
  const folder = path.resolve(folderArg ?? process.cwd())
  const a = load(folder, file.head, file.base)
  if (a.headSha !== file.headSha)
    fail(`${file.head} is at ${a.headSha.slice(0, 10)} now, but the file was written for ${file.headSha.slice(0, 10)}. Hunk numbers may have moved: run \`semantic-zoom export\` again and redo the file.`)

  if (file.changes) {
    if (!Array.isArray(file.changes)) fail('"changes" must be a list')
    const cs = checkChanges(a, file.changes.map((c) => ({ title: String(c.title ?? ''), summary: String(c.summary ?? ''), hunks: Array.isArray(c.hunks) ? c.hunks.map(String) : [] })), file.by)
    saveDescriptions(folder, file.head, file.base, cs)
    console.log(`changes: ${cs.items.length} saved`)
    if (cs.invalid.length) console.log(`  dropped ${cs.invalid.length} hunk ids that don't exist: ${cs.invalid.join(', ')}`)
    if (cs.undescribed.length) console.log(`  ${cs.undescribed.length} hunks no change covers (shown as "Not described"): ${cs.undescribed.join(', ')}`)
  }

  if (file.findings) {
    if (!Array.isArray(file.findings)) fail('"findings" must be a list')
    const paths = a.files.map((f) => f.path)
    const onMap = (p: string) => paths.some((f) => f === p || f.startsWith(p.replace(/\/$/, '') + '/'))
    const unknown = new Set<string>()
    const findings: Finding[] = file.findings.map((f) => {
      const severity = SEVERITIES.includes(f.severity) ? f.severity : 'info'
      const good = (f.paths ?? []).map(String).filter((p) => (onMap(p) ? true : (unknown.add(p), false)))
      return {
        severity,
        kind: 'ai-review',
        title: String(f.title ?? 'Untitled'),
        ...(f.detail ? { detail: String(f.detail) } : {}),
        ...(f.evidence?.length ? { evidence: f.evidence.map(String) } : {}),
        ...(good.length ? { target: { paths: good } } : {}),
        by: file.by,
      }
    })
    const review: Review = { by: file.by, generatedAt: new Date().toISOString(), headSha: a.headSha, findings, unknownPaths: [...unknown] }
    saveReview(folder, file.head, file.base, review)
    const count = (s: Severity) => findings.filter((f) => f.severity === s).length
    console.log(`findings: ${findings.length} saved (${count('violation')} bugs, ${count('warning')} to check, ${count('info')} notes)`)
    if (unknown.size) console.log(`  dropped paths that aren't on the map: ${[...unknown].join(', ')}`)
    const bad = file.findings.filter((f) => !SEVERITIES.includes(f.severity)).length
    if (bad) console.log(`  ${bad} findings had no valid severity and were saved as notes`)
  }
  console.log(`Saved for ${file.head} against ${file.base}. The app shows it when its window next comes forward.`)
}

const command = args.shift()
if (command === 'export') exportInput()
else if (command === 'import') importReview()
else fail('usage: semantic-zoom export [folder] [--head <branch>] [--base <ref>] | semantic-zoom import <file.json> [folder]')
