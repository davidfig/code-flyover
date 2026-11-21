// Usage: npm run analyze -- <repo path> <head branch> [base, default origin/main]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'
import type { AnalysisIndexEntry } from '../shared/types.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [repoArg, head, base = 'origin/main'] = process.argv.slice(2)
if (!repoArg || !head) {
  console.error('usage: npm run analyze -- <repo path> <head branch> [base]')
  process.exit(1)
}

const started = Date.now()
const a = analyze({ repo: path.resolve(repoArg), head, base, modelsDir: path.join(root, 'models') })
const dataDir = path.join(root, 'public', 'data')
fs.mkdirSync(dataDir, { recursive: true })
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
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
