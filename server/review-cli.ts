// Lets an outside AI (a Claude Code session, say) write what the app shows: the change descriptions and a review.
//
// flyover export [folder] [--head <branch>] [--base <ref>]
//   Prints what the AI needs: the instructions, the JSON to write, the branch's numbered hunks and the paths it may
//   point at. The head defaults to the folder's checked-out branch, the base to the repo's default branch.
// flyover import <file.json> [folder]
//   Checks that file against the code (hunk ids, coverage, paths, the head commit) and saves it where the app looks
//   (~/.code-flyover, server/api.ts). The app shows it within a few seconds (web/main.ts, showNewlySaved).
//
// Run through bin/flyover.mjs, which hands these two commands to tsx.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { branchSummary, CHANGE_RULES, checkChanges, describable, renderDiff } from '../analyzer/describe.ts'
import { readFiles } from '../analyzer/git.ts'
import { addRepo, analysisFor, defaultBase, loadReview, saveDescriptions, saveReview } from './api.ts'
import { headerOf } from './headers.ts'
import { saveNotes } from './notes.ts'
import type { Analysis, FileNote, Finding, Review, Severity } from '../shared/types.ts'

/** What the AI writes (and `import` reads). */
interface ReviewFile {
  by: string
  head: string
  base: string
  headSha: string
  changes?: { title: string; summary: string; hunks: string[] }[]
  findings?: { severity: Severity; title: string; detail?: string; evidence?: string[]; paths?: string[] }[]
  files?: { path: string; about: string; change: string }[]
  folders?: { path: string; about: string }[]
}

/** The changed files to describe: source, tests and docs (translations and generated files say nothing worth a tooltip). */
const toDescribe = (a: Analysis) => a.files.filter((f) => f.status !== 'unchanged' && (f.role === 'source' || f.role === 'test' || f.role === 'doc'))

/**
 * The folders to describe: every folder above a changed file, less a module's own folder when the architecture model
 * already describes that module (the map shows the model's words there).
 */
function foldersToDescribe(a: Analysis): string[] {
  const described = new Set(a.model.modules.filter((m) => m.description).flatMap((m) => m.paths.map((p) => p.replace(/\/$/, ''))))
  const out = new Set<string>()
  for (const f of toDescribe(a)) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!described.has(dir)) out.add(dir)
    }
  }
  return [...out].sort()
}

/** For each folder to describe: its subfolders, and its files with their opening comments (what the AI writes from). */
function folderEvidence(a: Analysis, repoPath: string): string[] {
  const folders = foldersToDescribe(a)
  const paths = a.files.map((f) => f.path)
  const inFolder = (dir: string) => paths.filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'))
  const subfolders = (dir: string) => [...new Set(paths.filter((p) => p.startsWith(dir + '/') && p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1).split('/')[0]))].sort()
  const texts = readFiles(repoPath, a.headSha, [...new Set(folders.flatMap(inFolder))])
  const out: string[] = []
  for (const dir of folders) {
    out.push(`### ${dir}`)
    const subs = subfolders(dir)
    if (subs.length) out.push(`Folders: ${subs.join(', ')}`)
    const files = inFolder(dir)
    for (const p of files.slice(0, 40)) {
      const head = headerOf(texts.get(p) ?? '', p)
      out.push(`- ${p.slice(dir.length + 1)}${head ? `: ${head}` : ''}`)
    }
    if (files.length > 40) out.push(`- and ${files.length - 40} more files`)
    out.push('')
  }
  return out
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
    files: [{ path: toDescribe(a)[0]?.path ?? 'path/to/file.ts', about: '…', change: '…' }],
    folders: [{ path: foldersToDescribe(a)[0] ?? 'path/to', about: '…' }],
  }
  const out = [
    `# Code Flyover: review input for ${a.repo}, ${head} against ${base}`,
    '',
    a.uncommitted
      ? `This includes the uncommitted changes in ${a.uncommitted}, as a snapshot of its files (headSha ${a.headSha}; no branch points at it). If those files change before you import, the import says so: export again. Write one JSON file, then run \`flyover import <file>\` in the repo (or pass the repo's folder after the file).`
      : `Head commit ${a.headSha}. Write one JSON file, then run \`flyover import <file>\` in the repo (or pass the repo's folder after the file).`,
    'The import checks the file against this commit and tells you what it dropped; fix the file and import again until it reports nothing dropped.',
    '',
    '## The file to write',
    '',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
    '',
    'Copy head, base and headSha exactly. `changes`, `findings`, `files` and `folders` are each optional: leave one out to keep what the app has.',
    '',
    '## changes: what the branch does',
    '',
    CHANGE_RULES,
    '',
    '## findings: your review',
    '',
    'Bugs and risks you found in the branch, most important first. Each one shows in the app\'s panel under "AI review", apart from the analyzer\'s architecture findings, and clicking it flies the map to its paths.',
    '',
    'Review the branch for real: read beyond the diff where it matters (callers of changed functions, the tests, the code a change relies on). Look for wrong behaviour, missed cases, crashes, races, lost data, security holes and broken contracts with callers. Every finding needs evidence from the code. Don\'t invent findings to fill the list: an empty list is a fine answer.',
    '',
    'For each finding:',
    '',
    '- severity: "violation" for a bug (wrong behaviour, a crash, lost data, a security hole), "warning" for something to check (risky, unclear, untested), "info" for a note.',
    '- title: the problem in at most 10 words.',
    '- detail: one to three sentences: what goes wrong and when. Say how sure you are when you are not.',
    '- evidence: the lines that show it, as "path:line  code".',
    '- paths: the files (or folders) to look at, from the list below. Paths not on the map are dropped from the target.',
    '- Leave out style preferences and anything the analyzer already reports (below).',
    '',
    '## files: what each changed file is, and what the branch did to it',
    '',
    'Two lines for each changed file listed here, shown in a tooltip when the reviewer hovers over the file\'s name on the map. Write them from your reading of the file, not from its name alone.',
    '',
    '- about: what the file is for in the codebase, in one sentence, as it is now: its job, not its contents in full ("Syncs the local library with the account\'s cloud copies"). The same on any branch.',
    '- change: what this branch did to it, in one sentence ("Adds encrypted folders: keys are fetched before a folder\'s documents sync"). For a new file, what it adds; for a deleted one, what went with it. Describe only, as in changes.',
    '',
    ...toDescribe(a).map((f) => `- ${f.path}`),
    '',
    '## folders: what each folder holds',
    '',
    'One sentence for each folder below, shown in a tooltip when the reviewer hovers over the folder\'s name on the map: what is kept in it, as it is now ("The search index: the worker that builds it, and querying it"). Not what the branch changed: the files and changes say that.',
    '',
    'Write it from the evidence listed under each folder (its subfolders, and each file with the comment it opens with), and from files you read. Where that evidence is too thin to say what the folder holds, leave the folder out rather than guess from its name.',
    '',
    ...folderEvidence(a, repo.path),
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
    ...(a.otherChanges.length ? ['', 'Also changed, but not on the map (assets, config and other files):', '', ...a.otherChanges.map((o) => `- ${o.path}`)] : []),
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
  if (!fileArg) fail('usage: flyover import <file.json> [repo folder]')
  let file: ReviewFile
  try {
    file = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'))
  } catch (e) {
    fail(`Couldn't read ${fileArg}: ${e instanceof Error ? e.message : e}`)
  }
  for (const k of ['by', 'head', 'base', 'headSha'] as const) if (typeof file[k] !== 'string' || !file[k]) fail(`${fileArg} needs "${k}" (copy it from \`flyover export\`)`)
  if (!file.changes && !file.findings && !file.files && !file.folders) fail(`${fileArg} has none of "changes", "findings", "files" or "folders"`)
  const folder = path.resolve(folderArg ?? process.cwd())
  const a = load(folder, file.head, file.base)
  if (a.headSha !== file.headSha)
    fail(`${file.head} ${a.uncommitted ? 'or its uncommitted files have' : 'has'} changed since the file was written (${file.headSha.slice(0, 10)}, now ${a.headSha.slice(0, 10)}). Hunk numbers may have moved: run \`flyover export\` again and redo the file.`)

  if (file.changes) {
    if (!Array.isArray(file.changes)) fail('"changes" must be a list')
    const cs = checkChanges(a, file.changes.map((c) => ({ title: String(c.title ?? ''), summary: String(c.summary ?? ''), hunks: Array.isArray(c.hunks) ? c.hunks.map(String) : [] })), file.by)
    saveDescriptions(folder, file.head, file.base, cs)
    console.log(`changes: ${cs.items.length} saved`)
    if (cs.invalid.length) console.log(`  dropped ${cs.invalid.length} hunk ids that don't exist: ${cs.invalid.join(', ')}`)
    if (cs.undescribed.length) console.log(`  ${cs.undescribed.length} hunks no change covers (shown as "Not described"): ${cs.undescribed.join(', ')}`)
  }

  // The review holds the findings and the file notes. A part left out of the file keeps what was saved, while that is for
  // this same commit (or snapshot); one for an older commit would pass for this one, so it goes.
  if (file.findings || file.files || file.folders) {
    const before = loadReview(folder, file.head, file.base)
    const kept = before?.headSha === a.headSha ? before : undefined
    const review: Review = { by: file.by, generatedAt: new Date().toISOString(), headSha: a.headSha, findings: kept?.findings ?? [], unknownPaths: kept?.unknownPaths ?? [], ...(kept?.files ? { files: kept.files } : {}), ...(kept?.folders ? { folders: kept.folders } : {}) }

    if (file.findings) {
      if (!Array.isArray(file.findings)) fail('"findings" must be a list')
      const paths = a.files.map((f) => f.path)
      const onMap = (p: string) => paths.some((f) => f === p || f.startsWith(p.replace(/\/$/, '') + '/'))
      const unknown = new Set<string>()
      review.findings = file.findings.map((f): Finding => {
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
      review.unknownPaths = [...unknown]
      const count = (s: Severity) => review.findings.filter((f) => f.severity === s).length
      console.log(`findings: ${review.findings.length} saved (${count('violation')} bugs, ${count('warning')} to check, ${count('info')} notes)`)
      if (unknown.size) console.log(`  dropped paths that aren't on the map: ${[...unknown].join(', ')}`)
      const bad = file.findings.filter((f) => !SEVERITIES.includes(f.severity)).length
      if (bad) console.log(`  ${bad} findings had no valid severity and were saved as notes`)
    }

    if (file.files) {
      if (!Array.isArray(file.files)) fail('"files" must be a list')
      const wanted = new Set(toDescribe(a).map((f) => f.path))
      const notes: Record<string, FileNote> = {}
      const unknown: string[] = []
      for (const f of file.files) {
        const p = String(f?.path ?? '')
        if (!wanted.has(p)) unknown.push(p)
        else notes[p] = { about: String(f.about ?? '').trim(), change: String(f.change ?? '').trim() }
      }
      review.files = notes
      const missing = [...wanted].filter((p) => !notes[p])
      console.log(`files: ${Object.keys(notes).length} described`)
      if (unknown.length) console.log(`  dropped paths that aren't changed files on the map: ${unknown.join(', ')}`)
      if (missing.length) console.log(`  ${missing.length} changed files have no description: ${missing.join(', ')}`)
    }

    if (file.folders) {
      if (!Array.isArray(file.folders)) fail('"folders" must be a list')
      const wanted = new Set(foldersToDescribe(a))
      const notes: Record<string, string> = {}
      const unknown: string[] = []
      for (const f of file.folders) {
        const p = String(f?.path ?? '').replace(/\/$/, '')
        const about = String(f?.about ?? '').trim()
        if (!wanted.has(p)) unknown.push(p)
        else if (about) notes[p] = about
      }
      review.folders = notes
      console.log(`folders: ${Object.keys(notes).length} of ${wanted.size} described`)
      if (unknown.length) console.log(`  dropped paths that aren't folders above changed files: ${unknown.join(', ')}`)
    }

    saveReview(folder, file.head, file.base, review)

    // What each file and folder is doesn't depend on the branch: the repo's notes keep it (server/notes.ts), tied to
    // the files as they are at this head, so other branches where they're the same show it too.
    if (file.files || file.folders) {
      const repo = addRepo(folder)
      const abouts = Object.fromEntries(Object.entries(file.files ? review.files ?? {} : {}).filter(([, n]) => n.about).map(([p, n]) => [p, n.about]))
      const saved = saveNotes(repo.id, repo.path, a.headSha, file.by, abouts, file.folders ? review.folders ?? {} : {})
      if (saved.files || saved.folders) console.log(`repo notes: ${saved.files} files and ${saved.folders} folders kept for every branch where they're unchanged`)
    }
  }
  console.log(`Saved for ${file.head} against ${file.base}. The app shows it within a few seconds, without moving the map.`)
}

const command = args.shift()
if (command === 'export') exportInput()
else if (command === 'import') importReview()
else fail('usage: flyover export [folder] [--head <branch>] [--base <ref>] | flyover import <file.json> [folder]')
