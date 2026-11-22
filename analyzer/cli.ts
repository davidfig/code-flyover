// Prints a branch's analysis in the terminal, with any change descriptions an outside AI saved for it
// (`semantic-zoom import`). The app itself analyzes on demand: run `semantic-zoom` to open it. Never calls a model.
//
// Usage: npm run analyze -- <repo path> <head branch> [base, default the remote's default branch] [--id <name>]
// --id <name>     name the analysis (default: <repo>--<head>)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'
import { defaultBase, loadDescriptions } from '../server/api.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  return value
}
const idOption = option('--id')
const [repoArg, head, baseArg] = args
if (!repoArg || !head) {
  console.error('usage: npm run analyze -- <repo path> <head branch> [base] [--id <name>]')
  process.exit(1)
}

const base = baseArg ?? defaultBase(path.resolve(repoArg))
const started = Date.now()
const a = analyze({ repo: path.resolve(repoArg), head, base, modelsDir: path.join(root, 'models'), id: idOption })
a.changes = loadDescriptions(path.resolve(repoArg), head, base)
const changed = a.files.filter((f) => f.status !== 'unchanged')

console.log(`${a.id}: ${a.files.length} files on the map, ${changed.length} changed, ${a.edges.length} imports, ${a.impacted.length} impacted`)
console.log(`model: ${a.model.name} (${a.model.kind}), ${a.model.modules.length} modules`)
for (const f of a.findings) console.log(`  [${f.severity}] ${f.title}`)
if (a.changes) {
  console.log(`changes (${a.changes.by}):`)
  for (const c of a.changes.items) console.log(`  · ${c.title}  [${c.files.length} files, ${c.hunks.length} hunks]`)
  if (a.changes.undescribed.length) console.log(`  ! ${a.changes.undescribed.length} hunks not described`)
  if (a.changes.invalid.length) console.log(`  ! ${a.changes.invalid.length} cited hunk ids don't exist`)
}
if (!a.changes) console.log('no change descriptions (run /zoom-review in a Claude Code session to write them)')
else if (a.changes.headSha !== a.headSha) console.log('the saved change descriptions are for an older commit: run /zoom-review again')
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
