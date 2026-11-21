// Prints a branch's analysis in the terminal, and with --describe writes its change descriptions where the app finds
// them (~/.semantic-zoom, see server/api.ts). The app itself analyzes on demand: run `semantic-zoom` to open it.
//
// Usage: npm run analyze -- <repo path> <head branch> [base, default the remote's default branch] [--describe] [--model <id>] [--redescribe]
//
// The analysis itself never calls a model. AI change descriptions are written only when you ask:
// --describe      write them (one Claude API call), or reuse the ones cached for this head commit and model
// --model <id>    the model that writes them (default: see analyzer/describe.ts); implies --describe
// --redescribe    write them again even if the head commit hasn't changed; implies --describe
// Without these, descriptions already cached for this head commit (by any model) are still shown: no API call.
// --id <name>     name the analysis (default: <repo>--<head>)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.ts'
import { DEFAULT_MODEL, describeChanges } from './describe.ts'
import { defaultBase, loadDescriptions, saveDescriptions } from '../server/api.ts'

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
flag('--no-describe') // the old opt-out: now the default, so accepted and ignored
const redescribe = flag('--redescribe')
const modelOption = option('--model')
const describe = flag('--describe') || redescribe || modelOption !== undefined
const model = modelOption ?? DEFAULT_MODEL
const idOption = option('--id')
const [repoArg, head, baseArg] = args
if (!repoArg || !head) {
  console.error('usage: npm run analyze -- <repo path> <head branch> [base] [--describe] [--model <id>] [--redescribe] [--id <name>]')
  process.exit(1)
}

const base = baseArg ?? defaultBase(path.resolve(repoArg))
const started = Date.now()
const a = analyze({ repo: path.resolve(repoArg), head, base, modelsDir: path.join(root, 'models'), id: idOption })
// Change descriptions: saved where the app looks, and reused while the head commit and model are the same.
const cached = loadDescriptions(path.resolve(repoArg), head, base)
if (cached && cached.headSha === a.headSha && !redescribe && (cached.by.startsWith(model) || !describe)) {
  a.changes = cached
} else if (describe) {
  try {
    const t = Date.now()
    a.changes = await describeChanges(a, model)
    saveDescriptions(path.resolve(repoArg), head, base, a.changes)
    console.log(`described by ${a.changes.by} in ${((Date.now() - t) / 1000).toFixed(1)}s`)
  } catch (e) {
    console.warn(`No change descriptions: ${e instanceof Error ? e.message : e}`)
  }
}
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
if (!a.changes) console.log('no change descriptions (add --describe to write them with the Claude API)')
else if (cached && cached.headSha !== a.headSha && !describe) console.log('the cached change descriptions are for an older commit: add --describe to write new ones')
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
