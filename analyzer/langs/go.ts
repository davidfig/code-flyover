// Go: a package is a folder, and the files in it see each other's top-level names. An import of a path under a
// `go.mod` module points at a folder in the repo; the file depends on the files there that declare the names it
// uses (`pkg.Name`). Same-package files depend on the siblings that declare the names they use. Imports from
// outside every module in the repo are third-party when the path starts with a domain (the standard library's
// don't).

import path from 'node:path/posix'
import { languageById } from '../../shared/languages.ts'
import { addDep, blank, emptyDeps, lineAt, type LangDeps, type Snapshot } from './common.ts'

interface GoFile {
  file: string
  dir: string
  pkg: string
  decls: Set<string>
  clean: string
  raw: string
}

export function goDeps(snap: Snapshot): LangDeps {
  const out = emptyDeps()
  const goFiles = [...snap.files].filter((f) => f.endsWith('.go'))
  if (!goFiles.length) return out
  const syntax = languageById('go')!.syntax

  const modules: { path: string; dir: string }[] = []
  for (const f of snap.files) {
    if (!f.endsWith('go.mod')) continue
    const m = /^\s*module\s+(\S+)/m.exec(snap.contents.get(f) ?? '')
    if (m) modules.push({ path: m[1].replace(/^"|"$/g, ''), dir: path.dirname(f) === '.' ? '' : path.dirname(f) })
  }
  modules.sort((a, b) => b.path.length - a.path.length)

  const byDir = new Map<string, GoFile[]>()
  const units: GoFile[] = []
  for (const file of goFiles) {
    const raw = snap.contents.get(file)
    if (raw === undefined) continue
    // Keep strings: import paths are strings. Names inside other strings rarely match a declaration.
    const clean = blank(raw, syntax, true)
    const dir = path.dirname(file) === '.' ? '' : path.dirname(file)
    const pkg = /^\s*package\s+(\w+)/m.exec(clean)?.[1] ?? ''
    const decls = new Set<string>()
    for (const m of clean.matchAll(/^func\s+(\w+)/gm)) decls.add(m[1])
    for (const m of clean.matchAll(/^(?:type|var|const)\s+(\w+)/gm)) decls.add(m[1])
    for (const m of clean.matchAll(/^(?:type|var|const)\s*\(([\s\S]*?)^\)/gm)) {
      for (const l of m[1].matchAll(/^\s+(\w+)/gm)) decls.add(l[1])
    }
    for (const n of ['init', 'main', '_']) decls.delete(n)
    const u = { file, dir, pkg, decls, clean, raw }
    units.push(u)
    const list = byDir.get(dir) ?? byDir.set(dir, []).get(dir)!
    list.push(u)
  }

  /** Files in `dir` that declare `name`; a test file only when `from` is one too. */
  const declaring = (dir: string, pkg: string | undefined, name: string, from: string) =>
    (byDir.get(dir) ?? [])
      .filter((g) => (pkg === undefined || g.pkg === pkg) && g.decls.has(name) && (!g.file.endsWith('_test.go') || from.endsWith('_test.go')))
      .map((g) => g.file)

  for (const u of units) {
    const ext = new Set<string>()
    const imports: { alias: string; dir: string; at: number }[] = []
    const importRe = /^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"|^\s*import\s*\(([\s\S]*?)^\s*\)/gm
    for (const m of u.clean.matchAll(importRe)) {
      const specs: { alias?: string; p: string; at: number }[] = []
      if (m[2]) specs.push({ alias: m[1], p: m[2], at: m.index! })
      else for (const l of m[3].matchAll(/^\s*([\w.]+\s+)?"([^"]+)"/gm)) specs.push({ alias: l[1]?.trim(), p: l[2], at: m.index! + m[0].indexOf(l[0]) })
      for (const s of specs) {
        const mod = modules.find((x) => s.p === x.path || s.p.startsWith(x.path + '/'))
        if (mod) {
          const dir = path.join(mod.dir || '.', s.p.slice(mod.path.length)).replace(/^\.\/?/, '')
          const there = (byDir.get(dir) ?? []).filter((g) => !g.pkg.endsWith('_test'))
          if (!there.length) continue
          const alias = s.alias ?? there[0].pkg
          if (alias === '_') addDep(out.deps, u.file, there[0].file, lineAt(u.raw, s.at))
          else imports.push({ alias, dir, at: s.at })
        } else if (/^[\w-]+\.[\w.-]+\//.test(s.p)) {
          const name = s.p.split('/').slice(0, 3).join('/')
          if (!ext.has(name)) {
            ext.add(name)
            const list = out.external.get(u.file) ?? out.external.set(u.file, []).get(u.file)!
            list.push({ to: name, line: lineAt(u.raw, s.at) })
          }
        }
      }
    }

    const code = blank(u.raw, syntax)
    for (const imp of imports) {
      if (imp.alias === '.') {
        for (const m of code.matchAll(/\b[A-Z]\w*/g)) for (const f of declaring(imp.dir, undefined, m[0], u.file)) addDep(out.deps, u.file, f, lineAt(u.raw, m.index!))
        continue
      }
      const re = new RegExp(`(?<![\\w.])${imp.alias.replace(/\W/g, '')}\\.(\\w+)`, 'g')
      let any = false
      for (const m of code.matchAll(re)) {
        for (const f of declaring(imp.dir, undefined, m[1], u.file)) {
          addDep(out.deps, u.file, f, lineAt(u.raw, m.index!))
          any = true
        }
      }
      // Used only for types we couldn't place, or a method's receiver: still a dependency on the package.
      if (!any) {
        const first = (byDir.get(imp.dir) ?? []).find((g) => !g.pkg.endsWith('_test'))
        if (first) addDep(out.deps, u.file, first.file, lineAt(u.raw, imp.at))
      }
    }

    // Same package: names declared by a sibling.
    const seen = new Set<string>()
    for (const m of code.matchAll(/(?<![\w.])[A-Za-z_]\w+/g)) {
      const id = m[0]
      if (seen.has(id) || u.decls.has(id)) continue
      seen.add(id)
      for (const f of declaring(u.dir, u.pkg, id, u.file)) addDep(out.deps, u.file, f, lineAt(u.raw, m.index!))
    }
  }
  return out
}
