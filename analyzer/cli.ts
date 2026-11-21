// Usage: npm run analyze -- <repo path> <head branch> [base, default origin/main] [--no-describe] [--model <id>] [--redescribe]
//
// --no-describe   skip the AI change descriptions (no API call)
// --model <id>    the model that writes them (default: see analyzer/describe.ts)
// --redescribe    write them again even if the head commit hasn't changed
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'
import { DEFAULT_MODEL, describeChanges } from './describe.ts'
import type { AnalysisIndexEntry, ChangeSet } from '../shared/types.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}
const option = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  return value
}
const noDescribe = flag('--no-describe')
const redescribe = flag('--redescribe')
const model = option('--model') ?? DEFAULT_MODEL
const [repoArg, head, base = 'origin/main'] = args
if (!repoArg || !head) {
  console.error('usage: npm run analyze -- <repo path> <head branch> [base] [--no-describe] [--model <id>] [--redescribe]')
  process.exit(1)
}

const started = Date.now()
const a = analyze({ repo: path.resolve(repoArg), head, base, modelsDir: path.join(root, 'models') })
const dataDir = path.join(root, 'public', 'data')
fs.mkdirSync(dataDir, { recursive: true })

// Change descriptions: kept beside the analysis and reused while the head commit and model are the same.
const changesPath = path.join(dataDir, a.id + '.changes.json')
const cached: ChangeSet | null = fs.existsSync(changesPath) ? JSON.parse(fs.readFileSync(changesPath, 'utf8')) : null
if (cached && cached.headSha === a.headSha && !redescribe && (cached.by.startsWith(model) || noDescribe)) {
  a.changes = cached
} else if (!noDescribe) {
  try {
    const t = Date.now()
    a.changes = await describeChanges(a, model)
    fs.writeFileSync(changesPath, JSON.stringify(a.changes, null, 2))
    console.log(`described by ${a.changes.by} in ${((Date.now() - t) / 1000).toFixed(1)}s`)
  } catch (e) {
    console.warn(`No change descriptions: ${e instanceof Error ? e.message : e}`)
  }
}

fs.writeFileSync(path.join(dataDir, a.id + '.json'), JSON.stringify(a))

const indexPath = path.join(dataDir, 'index.json')
const list: AnalysisIndexEntry[] = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : []
const changed = a.files.filter((f) => f.status !== 'unchanged')
const entry: AnalysisIndexEntry = {
  id: a.id,
  repo: a.repo,
  head: a.head,
  title: a.title,
  files: changed.length,
  add: changed.reduce((s, f) => s + f.add, 0),
  del: changed.reduce((s, f) => s + f.del, 0),
  findings: {
    violation: a.findings.filter((f) => f.severity === 'violation').length,
    warning: a.findings.filter((f) => f.severity === 'warning').length,
    info: a.findings.filter((f) => f.severity === 'info').length,
  },
}
fs.writeFileSync(indexPath, JSON.stringify([entry, ...list.filter((e) => e.id !== a.id)], null, 2))

console.log(`${a.id}: ${a.files.length} files on the map, ${changed.length} changed, ${a.edges.length} imports, ${a.impacted.length} impacted`)
console.log(`model: ${a.model.name} (${a.model.kind}), ${a.model.modules.length} modules`)
for (const f of a.findings) console.log(`  [${f.severity}] ${f.title}`)
if (a.changes) {
  console.log(`changes (${a.changes.by}):`)
  for (const c of a.changes.items) console.log(`  · ${c.title}  [${c.files.length} files, ${c.hunks.length} hunks]`)
  if (a.changes.undescribed.length) console.log(`  ! ${a.changes.undescribed.length} hunks not described`)
  if (a.changes.invalid.length) console.log(`  ! ${a.changes.invalid.length} cited hunk ids don't exist`)
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
