// Finds file-to-file dependencies in one snapshot of a repo.
// TypeScript/JavaScript: import/export/require/dynamic import/new URL(…, import.meta.url),
// resolved through relative paths and pnpm/npm workspace package names.
// Rust: `use` paths and inline `crate::`/`super::`/workspace-crate paths, resolved to module files.

import path from 'node:path/posix'

export const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
export const RS_EXT = /\.rs$/

export interface Snapshot {
  files: Set<string>
  contents: Map<string, string>
}

export interface Dep {
  to: string
  line: string
  /** `import type` / `export type`: erased at compile time */
  typeOnly?: boolean
}

export interface SnapshotDeps {
  /** file → files it depends on */
  deps: Map<string, Dep[]>
  /** file → bare package names it imports (third-party or builtin) */
  external: Map<string, Dep[]>
}

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'fs/promises', 'http', 'https', 'net', 'os',
  'path', 'path/posix', 'process', 'readline', 'stream', 'url', 'util', 'worker_threads', 'zlib', 'module', 'perf_hooks', 'timers',
])

// ---------- workspace packages ----------

interface WorkspacePackage {
  name: string
  dir: string
  exports: Record<string, string>
}

function workspacePackages(snap: Snapshot): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>()
  for (const f of snap.files) {
    if (!f.endsWith('package.json') || f.includes('node_modules/')) continue
    const text = snap.contents.get(f)
    if (!text) continue
    try {
      const pkg = JSON.parse(text)
      if (typeof pkg.name !== 'string') continue
      const dir = path.dirname(f) === '.' ? '' : path.dirname(f)
      const exports: Record<string, string> = {}
      const ex = pkg.exports
      if (typeof ex === 'string') exports['.'] = ex
      else if (ex && typeof ex === 'object') {
        for (const [k, v] of Object.entries(ex)) {
          const target = typeof v === 'string' ? v : (v as any)?.import ?? (v as any)?.default ?? (v as any)?.types
          if (typeof target === 'string') exports[k] = target
        }
      }
      if (!exports['.'] && typeof pkg.main === 'string') exports['.'] = pkg.main
      out.set(pkg.name, { name: pkg.name, dir, exports })
    } catch {
      // not JSON we can read; skip
    }
  }
  return out
}

// ---------- TypeScript / JavaScript ----------

const IMPORT_RES = [
  /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /new\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
]

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])(\/\/[^\n]*)/g, (_m, a: string, b: string) => a + ' '.repeat(b.length))
}

function lineAt(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  let end = src.indexOf('\n', index)
  if (end < 0) end = src.length
  return src.slice(start, end).trim()
}

function tsCandidates(p: string): string[] {
  const out = [p]
  const noExt = p.replace(/\.(js|jsx|mjs|cjs)$/, '')
  for (const ext of ['.ts', '.tsx', '.mts', '.d.ts', '.js', '.jsx', '.mjs']) out.push(noExt + ext)
  for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/mod.ts']) out.push(p + idx)
  return out
}

function resolveFile(snap: Snapshot, p: string): string | null {
  for (const c of tsCandidates(path.normalize(p))) if (snap.files.has(c)) return c
  return null
}

function packageName(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function resolveTs(snap: Snapshot, pkgs: Map<string, WorkspacePackage>, from: string, rawSpec: string): { file?: string; external?: string } {
  const spec = rawSpec.split('?')[0]
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const target = spec.startsWith('/') ? spec.slice(1) : path.join(path.dirname(from), spec)
    const file = resolveFile(snap, target)
    return file ? { file } : {}
  }
  const name = packageName(spec)
  const pkg = pkgs.get(name)
  if (pkg) {
    const sub = '.' + spec.slice(name.length)
    const target = pkg.exports[sub] ?? (sub === '.' ? 'src/index.ts' : `src${sub.slice(1)}`)
    const file = resolveFile(snap, path.join(pkg.dir, target))
    return file ? { file } : {}
  }
  if (spec.startsWith('node:') || NODE_BUILTINS.has(spec)) return { external: 'node:' + spec.replace(/^node:/, '') }
  if (spec.startsWith('virtual:') || spec.startsWith('~')) return {}
  return { external: name }
}

// ---------- Rust ----------

interface Crate {
  name: string // as used in paths (underscores)
  dir: string // e.g. crates/core
  modules: Map<string, string> // "a::b" → file
}

function rustCrates(snap: Snapshot): Crate[] {
  const crates: Crate[] = []
  for (const f of snap.files) {
    if (!f.endsWith('Cargo.toml')) continue
    const text = snap.contents.get(f) ?? ''
    const pkg = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(text)
    if (!pkg) continue
    const lib = /\[lib\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(text)
    const dir = path.dirname(f) === '.' ? '' : path.dirname(f)
    const name = (lib?.[1] ?? pkg[1]).replace(/-/g, '_')
    crates.push({ name, dir, modules: new Map() })
  }
  // Longest dir first so nested crates win.
  crates.sort((a, b) => b.dir.length - a.dir.length)
  for (const f of snap.files) {
    if (!RS_EXT.test(f)) continue
    const crate = crates.find((c) => f.startsWith(c.dir ? c.dir + '/src/' : 'src/'))
    if (!crate) continue
    const rel = f.slice((crate.dir ? crate.dir + '/' : '').length + 4).replace(/\.rs$/, '')
    let mod = rel.replace(/\/mod$/, '').replace(/\//g, '::')
    if (mod === 'lib' || mod === 'main') mod = ''
    if (!crate.modules.has(mod) || rel === 'lib') crate.modules.set(mod, f)
  }
  return crates
}

function rustModuleOf(crate: Crate, file: string): string[] {
  for (const [m, f] of crate.modules) if (f === file) return m ? m.split('::') : []
  return []
}

/** Expand `a::{b, c::{d, e}}` into ['a::b', 'a::c::d', 'a::c::e']. */
function expandUse(tree: string): string[] {
  tree = tree.replace(/\s+/g, '')
  const brace = tree.indexOf('{')
  if (brace < 0) return [tree.replace(/::\*$/, '').replace(/as\w+$/, '')]
  const prefix = tree.slice(0, brace)
  const inner = tree.slice(brace + 1, tree.lastIndexOf('}'))
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '{') depth++
    else if (inner[i] === '}') depth--
    else if (inner[i] === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1 }
  }
  parts.push(inner.slice(start))
  return parts.filter(Boolean).flatMap((p) => expandUse(p === 'self' ? prefix.replace(/::$/, '') : prefix + p))
}

function rustDeps(snap: Snapshot, crates: Crate[], file: string): Dep[] {
  const crate = crates.find((c) => [...c.modules.values()].includes(file))
  if (!crate) return []
  const src = stripComments(snap.contents.get(file) ?? '')
  const here = rustModuleOf(crate, file)
  const byName = new Map(crates.map((c) => [c.name, c]))
  const paths: { p: string; line: string }[] = []
  for (const m of src.matchAll(/\buse\s+([^;]+);/g)) {
    for (const p of expandUse(m[1])) paths.push({ p, line: lineAt(src, m.index!) })
  }
  const names = ['crate', 'super', ...byName.keys()].map((n) => n.replace(/[^\w]/g, ''))
  const inline = new RegExp(`(?<![\\w:])(${names.join('|')})((?:::\\w+)+)`, 'g')
  const noUse = src.replace(/\buse\s+[^;]+;/g, (m) => ' '.repeat(m.length))
  for (const m of noUse.matchAll(inline)) paths.push({ p: m[1] + m[2], line: lineAt(src, m.index!) })

  const out: Dep[] = []
  const seen = new Set<string>()
  for (const { p, line } of paths) {
    const segs = p.split('::').filter(Boolean)
    let target: Crate | undefined
    let mod: string[]
    if (segs[0] === 'crate') { target = crate; mod = segs.slice(1) }
    else if (segs[0] === 'super' || segs[0] === 'self') {
      target = crate
      let base = here.slice()
      let i = 0
      while (segs[i] === 'super') { base = base.slice(0, -1); i++ }
      if (segs[i] === 'self') i++
      mod = [...base, ...segs.slice(i)]
    } else if (byName.has(segs[0]) && segs[0] !== crate.name) { target = byName.get(segs[0]); mod = segs.slice(1) }
    else continue
    // Longest module prefix that is a file.
    let resolved: string | undefined
    for (let n = mod.length; n >= 0; n--) {
      const f = target!.modules.get(mod.slice(0, n).join('::'))
      if (f) { resolved = f; break }
    }
    if (resolved && resolved !== file && !seen.has(resolved)) {
      seen.add(resolved)
      out.push({ to: resolved, line })
    }
  }
  return out
}

// ---------- entry ----------

export function snapshotDeps(snap: Snapshot): SnapshotDeps {
  const pkgs = workspacePackages(snap)
  const crates = rustCrates(snap)
  const deps = new Map<string, Dep[]>()
  const external = new Map<string, Dep[]>()
  for (const file of snap.files) {
    if (file.includes('node_modules/')) continue
    if (TS_EXT.test(file)) {
      const src = snap.contents.get(file)
      if (src === undefined) continue
      const clean = stripComments(src)
      const d: Dep[] = []
      const e: Dep[] = []
      const seen = new Set<string>()
      for (const re of IMPORT_RES) {
        for (const m of clean.matchAll(re)) {
          const r = resolveTs(snap, pkgs, file, m[1])
          const line = lineAt(src, m.index! + m[0].indexOf(m[1]))
          const typeOnly = /^[\s;]*(?:import|export)\s+type\b/.test(m[0])
          if (r.file && r.file !== file) {
            const prev = d.find((x) => x.to === r.file)
            if (!prev) d.push({ to: r.file, line, typeOnly })
            else if (!typeOnly && prev.typeOnly) { prev.typeOnly = false; prev.line = line }
          }
          if (r.external && !seen.has('ext:' + r.external)) { seen.add('ext:' + r.external); e.push({ to: r.external, line }) }
        }
      }
      deps.set(file, d)
      if (e.length) external.set(file, e)
    } else if (RS_EXT.test(file)) {
      deps.set(file, rustDeps(snap, crates, file))
    }
  }
  return { deps, external }
}

/** Files whose contents the dependency pass needs (code plus manifests). */
export function neededForDeps(files: string[]): string[] {
  return files.filter(
    (f) => !f.includes('node_modules/') && (TS_EXT.test(f) || RS_EXT.test(f) || f.endsWith('package.json') || f.endsWith('Cargo.toml')),
  )
}
