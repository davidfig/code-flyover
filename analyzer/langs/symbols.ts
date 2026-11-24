// Languages where a file reaches others by name, not by path: C#, Java, Kotlin, Scala, Swift, PHP and Ruby.
//
// Each file declares types into a scope (a namespace, package or module) and can see some scopes: its own, the
// ones it imports wholesale (`using X;`, `import a.b.*`, `import Module`), and single names it imports
// (`import a.b.C`, `use A\B\C`). A file depends on another when it uses a name the other declares in a scope it can
// see. So two C# files in one namespace depend on each other without any `using`, as they do in the compiler.
// It's names, not types: a local variable that happens to share a class's name counts too. Close enough for a map.

import { languageById } from '../../shared/languages.ts'
import { addDep, blank, emptyDeps, lineAt, type LangDeps, type Snapshot } from './common.ts'

interface Unit {
  file: string
  /** the scopes this file declares into */
  scopes: string[]
  /** names it declares */
  decls: string[]
  /** name used in the file → the qualified name it refers to (`scope.Name`) */
  explicit: Map<string, string>
  /** scopes it sees whole, besides its own */
  open: string[]
  /** where the file's text is, with comments and strings blanked */
  clean: string
}

interface Family {
  id: string
  ext: RegExp
  /** C#: a namespace sees its parents' names too */
  parents?: boolean
  /** which identifiers can name a declaration (default: capitalized) */
  ident?: RegExp
  read(file: string, clean: string, raw: string): Omit<Unit, 'file' | 'clean'>
}

const CAPS = /\b[A-Z]\w*/g
/** The first captured group of each match (a pattern may have alternatives, each with its own group). */
const words = (s: string, re: RegExp) => [...s.matchAll(re)].map((m) => m.slice(1).find((g) => g !== undefined)).filter((g): g is string => !!g)

/** `a.b.C` → ['a.b', 'C'] */
const split = (q: string): [string, string] => {
  const i = q.lastIndexOf('.')
  return i < 0 ? ['', q] : [q.slice(0, i), q.slice(i + 1)]
}

const csharp: Family = {
  id: 'csharp',
  ext: /\.(cs|csx)$/,
  parents: true,
  read(_file, clean) {
    const scopes = words(clean, /\bnamespace\s+([\w.]+)/g)
    const explicit = new Map<string, string>()
    const open: string[] = []
    for (const m of clean.matchAll(/^\s*(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm)) {
      if (m[2]) explicit.set(m[2], m[3])
      else if (m[1]) explicit.set(split(m[3])[1], m[3])
      else open.push(m[3])
    }
    const decls = [
      ...words(clean, /\b(?:class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+(\w+)/g),
      ...words(clean, /\bdelegate\s+[\w<>[\],.?\s]+?\s+(\w+)\s*[<(]/g),
    ]
    return { scopes: scopes.length ? scopes : [''], decls, explicit, open }
  },
}

/** Java, Kotlin, Scala and Groovy-ish: one package, imports of single names or whole packages. */
function jvm(id: string, ext: RegExp, declRe: RegExp, ident?: RegExp): Family {
  return {
    id,
    ext,
    ident,
    read(_file, clean) {
      // Scala can chain `package a` / `package b` to mean a.b.
      const pkg = words(clean, /^\s*package\s+([\w.]+)/gm).join('.')
      const explicit = new Map<string, string>()
      const open: string[] = []
      for (const m of clean.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*|\._|\.\{([^}]*)\})?(?:\s+as\s+(\w+))?\s*;?\s*$/gm)) {
        const q = m[1]
        if (m[3] !== undefined) {
          // Scala: import a.b.{C, D => E, _}
          for (const part of m[3].split(',')) {
            const [name, alias] = part.split(/=>/).map((s) => s.trim())
            if (name === '_' || name === '*') open.push(q)
            else if (name) explicit.set(alias && alias !== '_' ? alias : name, q + '.' + name)
          }
        } else if (m[2]) open.push(q)
        else {
          explicit.set(m[4] ?? split(q)[1], q)
          // `import static a.b.C.method`: the class is what the file depends on.
          const [owner] = split(q)
          if (/^[A-Z]/.test(split(owner)[1])) explicit.set(split(q)[1], owner)
        }
      }
      const decls = words(clean, declRe).filter((n) => n !== 'main')
      return { scopes: [pkg], decls, explicit, open }
    },
  }
}

const java = jvm('java', /\.java$/, /\b(?:class|interface|enum|record|@interface)\s+(\w+)/g)
// Kotlin: types, plus top-level functions and properties (at the start of a line), which are imported by name too.
const kotlin = jvm(
  'kotlin',
  /\.(kt|kts)$/,
  /(?:\b(?:class|interface|object|typealias)\s+(\w+)|^(?:(?:public|internal|private|inline|suspend|operator|infix|const)\s+)*(?:fun|val|var)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+))/gm,
  /\b[A-Za-z_]\w*/g,
)
const scala = jvm('scala', /\.(scala|sc)$/, /\b(?:class|trait|object|enum|type)\s+(\w+)/g)

/** Swift: every file in a module sees every other; `import X` brings in module X (a target in Sources/X). */
const swift: Family = {
  id: 'swift',
  ext: /\.swift$/,
  read(file, clean) {
    const open = words(clean, /^\s*(?:@testable\s+)?import\s+(?:(?:class|struct|enum|protocol|func|var|typealias)\s+)?(\w+)/gm)
    const decls = words(clean, /\b(?:class|struct|enum|protocol|actor|typealias)\s+(\w+)/g)
    return { scopes: [swiftModule(file)], decls, explicit: new Map(), open }
  },
}

function swiftModule(file: string): string {
  const segs = file.split('/')
  const i = segs.findIndex((s) => s === 'Sources' || s === 'Tests')
  if (i >= 0 && i + 1 < segs.length - 1) return segs[i + 1]
  return segs.length > 1 ? segs[0] : ''
}

/** PHP: namespaces with `\`, `use A\B\C [as D];`, group uses, and fully qualified `\A\B\C` in the code. */
const php: Family = {
  id: 'php',
  ext: /\.(php|phtml)$/,
  read(_file, clean) {
    const dot = (s: string) => s.replace(/^\\/, '').replace(/\\/g, '.')
    const scopes = words(clean, /\bnamespace\s+([\w\\]+)\s*[;{]/g).map(dot)
    const explicit = new Map<string, string>()
    for (const m of clean.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+?)\\?\{([^}]*)\}\s*;/gm)) {
      for (const part of m[2].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/i)
        if (name) explicit.set(alias ?? split(dot(name))[1], dot(m[1]) + '.' + dot(name))
      }
    }
    for (const m of clean.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
      const q = dot(m[1])
      explicit.set(m[2] ?? split(q)[1], q)
    }
    // \Fully\Qualified\Name in the code: treated as if imported under its full path.
    for (const m of clean.matchAll(/\\?\b([A-Z]\w*(?:\\\w+)+)/g)) explicit.set(m[1].replace(/\\/g, '.'), dot(m[1]))
    const decls = words(clean, /\b(?:class|interface|trait|enum)\s+(\w+)/g)
    return { scopes: scopes.length ? scopes : [''], decls, explicit, open: [] }
  },
}

/** Ruby: constants are global (Rails autoloads them by name), so every file sees every class and module. */
const ruby: Family = {
  id: 'ruby',
  ext: /(\.(rb|rake)|(^|\/)(Rakefile|Gemfile))$/,
  read(_file, clean) {
    const decls = words(clean, /^\s*(?:class|module)\s+(?:[A-Z]\w*::)*([A-Z]\w*)/gm)
    return { scopes: [''], decls, explicit: new Map(), open: [] }
  },
}

const FAMILIES = [csharp, java, kotlin, scala, swift, php, ruby]

export function symbolDeps(snap: Snapshot): LangDeps {
  const out = emptyDeps()
  for (const fam of FAMILIES) familyDeps(snap, fam, out)
  return out
}

function familyDeps(snap: Snapshot, fam: Family, out: LangDeps): void {
  const syntax = languageById(fam.id)!.syntax
  const units: Unit[] = []
  for (const file of snap.files) {
    if (!fam.ext.test(file)) continue
    const raw = snap.contents.get(file)
    if (raw === undefined) continue
    const clean = blank(raw, syntax)
    units.push({ file, clean, ...fam.read(file, clean, raw) })
  }
  if (units.length < 2) return

  // C#: `global using` applies to every file in the project. Close enough: to every C# file.
  if (fam.id === 'csharp') {
    const globals = new Set<string>()
    for (const u of units) for (const m of u.clean.matchAll(/^\s*global\s+using\s+(?!static)(?:\w+\s*=\s*)?([\w.]+)\s*;/gm)) globals.add(m[1])
    for (const u of units) u.open.push(...globals)
  }

  // scope → name → files
  const index = new Map<string, Map<string, string[]>>()
  for (const u of units) {
    for (const scope of u.scopes) {
      const names = index.get(scope) ?? index.set(scope, new Map()).get(scope)!
      for (const d of u.decls) {
        const list = names.get(d) ?? names.set(d, []).get(d)!
        if (!list.includes(u.file)) list.push(u.file)
      }
    }
  }
  const lookup = (scope: string, name: string) => index.get(scope)?.get(name)

  for (const u of units) {
    const raw = snap.contents.get(u.file)!
    const visible = new Set<string>(u.open)
    for (const s of u.scopes) {
      visible.add(s)
      if (fam.parents) for (let p = s; p.includes('.'); ) visible.add((p = split(p)[0]))
      if (fam.parents) visible.add('')
    }
    const own = new Set(u.decls)
    const seen = new Set<string>()
    const identRe = new RegExp((fam.ident ?? CAPS).source, 'g')
    // Names in import lines count where they're imported; scan the whole file.
    for (const m of u.clean.matchAll(identRe)) {
      const id = m[0]
      if (seen.has(id)) continue
      seen.add(id)
      const at = m.index!
      const q = u.explicit.get(id)
      if (q) {
        const [scope, name] = split(q)
        for (const f of lookup(scope, name) ?? []) addDep(out.deps, u.file, f, lineAt(raw, at))
        continue
      }
      if (own.has(id) && !fam.parents) continue
      for (const scope of visible) {
        for (const f of lookup(scope, id) ?? lookup(scope, id + 'Attribute') ?? []) addDep(out.deps, u.file, f, lineAt(raw, at))
      }
    }
    // PHP's fully qualified names (`\A\B\C`) contain dots after `dot()`: look those up directly.
    if (fam.id === 'php') {
      for (const [used, q] of u.explicit) {
        if (!used.includes('.')) continue
        const [scope, name] = split(q)
        const at = raw.indexOf(used.replace(/\./g, '\\'))
        for (const f of lookup(scope, name) ?? []) addDep(out.deps, u.file, f, lineAt(raw, Math.max(0, at)))
      }
    }
  }
}
