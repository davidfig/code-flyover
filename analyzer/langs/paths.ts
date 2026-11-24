// Languages whose files name each other by path: C/C++/Objective-C `#include`, Dart `import`, Lua `require`, Ruby
// `require`/`require_relative` and PHP `require`/`include`. Plus the fallback for every other text file: the repo
// files it names in quotes (an HTML page's scripts, a CSS `@import`, a config file's entry point, a shell script's
// `source "./x.sh"`). A quoted path counts only if it is a file in the repo, so a fallback edge is rarely wrong,
// just sometimes missing.

import path from 'node:path/posix'
import { languageOf } from '../../shared/languages.ts'
import { addDep, blank, emptyDeps, joinIn, lineAt, SuffixIndex, type LangDeps, type Snapshot } from './common.ts'

const C_EXT = /\.(c|h|cc|cpp|cxx|c\+\+|hh|hpp|hxx|h\+\+|ipp|inl|tpp|m|mm|cu|cuh)$/
const dirOf = (f: string) => (path.dirname(f) === '.' ? '' : path.dirname(f))

export function pathDeps(snap: Snapshot): LangDeps {
  const out = emptyDeps()
  let index: SuffixIndex | undefined
  const all = { nearest: (suffix: string, from: string) => (index ??= new SuffixIndex(snap.files)).nearest(suffix, from) }
  const has = (p: string | undefined) => (p !== undefined && snap.files.has(p) ? p : undefined)
  const external = (file: string, name: string, at: number, src: string) => {
    const list = out.external.get(file) ?? out.external.set(file, []).get(file)!
    if (!list.some((d) => d.to === name)) list.push({ to: name, line: lineAt(src, at) })
  }

  // Dart packages in the repo: pubspec.yaml's name → its folder.
  const pubspecs = new Map<string, string>()
  for (const f of snap.files) {
    if (!f.endsWith('pubspec.yaml')) continue
    const m = /^name:\s*['"]?([\w-]+)/m.exec(snap.contents.get(f) ?? '')
    if (m) pubspecs.set(m[1], dirOf(f))
  }

  for (const file of snap.files) {
    const lang = languageOf(file)?.id
    if (!lang || !['c', 'dart', 'lua', 'ruby', 'php'].includes(lang)) continue
    const src = snap.contents.get(file)
    if (src === undefined) continue
    const clean = blank(src, languageOf(file)!.syntax, true)
    const dir = dirOf(file)
    const add = (to: string | undefined, at: number) => to && addDep(out.deps, file, to, lineAt(src, at))

    if (lang === 'c' && C_EXT.test(file)) {
      for (const m of clean.matchAll(/^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"])([^>"\n]+)[>"]/gm)) {
        const spec = m[2].trim()
        add((m[1] === '"' ? has(joinIn(dir, spec)) : undefined) ?? all.nearest(spec, file), m.index!)
      }
    } else if (lang === 'dart') {
      for (const m of clean.matchAll(/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1]
        if (spec.startsWith('dart:')) continue
        const pkg = /^package:([\w-]+)\/(.*)$/.exec(spec)
        if (pkg) {
          const root = pubspecs.get(pkg[1])
          if (root === undefined) external(file, pkg[1], m.index!, src)
          else add(has(joinIn(root, 'lib/' + pkg[2])), m.index!)
        } else add(has(joinIn(dir, spec)), m.index!)
      }
    } else if (lang === 'lua') {
      for (const m of clean.matchAll(/\brequire\s*\(?\s*['"]([\w./-]+)['"]/g)) {
        const rel = m[1].replace(/\./g, '/')
        add(all.nearest(rel + '.lua', file) ?? all.nearest(rel + '/init.lua', file), m.index!)
      }
    } else if (lang === 'ruby') {
      for (const m of clean.matchAll(/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1].endsWith('.rb') ? m[1] : m[1] + '.rb'
        add(has(joinIn(dir, spec)), m.index!)
      }
      for (const m of clean.matchAll(/\b(?:require|load)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1].endsWith('.rb') ? m[1] : m[1] + '.rb'
        add(all.nearest('lib/' + spec, file) ?? (spec.includes('/') ? all.nearest(spec, file) : has(spec)), m.index!)
      }
    } else if (lang === 'php') {
      for (const m of clean.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:(__DIR__|dirname\(__FILE__\))\s*\.\s*)?['"]([^'"]+\.php)['"]/g)) {
        const spec = m[1] ? m[2].replace(/^\//, '') : m[2]
        add(has(joinIn(dir, spec)) ?? all.nearest(spec.replace(/^(\.\.?\/)+/, ''), file), m.index!)
      }
    }
  }
  return out
}

/**
 * Every other text file: the repo files it names in quotes or `url(…)`, relative to the file or to the repo root,
 * outside comments.
 * `files` is the set this applies to.
 */
export function fallbackDeps(snap: Snapshot, files: Iterable<string>): LangDeps {
  const out = emptyDeps()
  for (const file of files) {
    const src = snap.contents.get(file)
    if (src === undefined || src.length > 2_000_000) continue
    const dir = dirOf(file)
    // A path named in a comment isn't a dependency. Only in languages whose comments we know.
    const syntax = languageOf(file)?.syntax
    const text = syntax ? blank(src, syntax, true) : src
    for (const m of text.matchAll(/["'`(]([\w@~.\/-]{3,200})["'`)]/g)) {
      const spec = m[1].split(/[?#]/)[0]
      // A path, not a word: it has a folder or an extension.
      if (!spec.includes('/') && !/\.\w{1,8}$/.test(spec)) continue
      // Relative to the file, then to the repo root (shell scripts and configs usually run from there).
      const target = [joinIn(dir, spec), joinIn('', spec.replace(/^~?\//, ''))].find((p) => p !== undefined && snap.files.has(p))
      if (target && target !== file) addDep(out.deps, file, target, lineAt(src, m.index!))
    }
  }
  return out
}
