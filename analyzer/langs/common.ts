// Helpers the language resolvers share.

import path from 'node:path/posix'
import type { Syntax } from '../../shared/languages.ts'

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

export interface LangDeps {
  /** file → files it depends on */
  deps: Map<string, Dep[]>
  /** file → third-party packages it imports */
  external: Map<string, Dep[]>
}

export const emptyDeps = (): LangDeps => ({ deps: new Map(), external: new Map() })

/** The trimmed source line around `index`. */
export function lineAt(src: string, index: number): string {
  const start = src.lastIndexOf('\n', index) + 1
  let end = src.indexOf('\n', index)
  if (end < 0) end = src.length
  return src.slice(start, end).trim()
}

/**
 * Blank out comments, and the insides of strings unless `keepStrings`, keeping every offset and newline in place
 * (so `lineAt` on the result's indexes still finds the right line of the original).
 */
export function blank(src: string, syntax: Syntax, keepStrings = false): string {
  const out = src.split('')
  const { quotes, triple, line = [], block } = syntax
  const wipe = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const lc = line.find((m) => src.startsWith(m, i))
    if (lc && (lc !== '#' || /[\s;(]/.test(src[i - 1] ?? '\n'))) {
      let end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      wipe(i, end)
      i = end
      continue
    }
    if (block && src.startsWith(block[0], i)) {
      let end = src.indexOf(block[1], i + block[0].length)
      end = end < 0 ? src.length : end + block[1].length
      wipe(i, end)
      i = end
      continue
    }
    if (quotes.includes(c)) {
      const q = triple && src.startsWith(c + c + c, i) ? c + c + c : c
      let j = i + q.length
      while (j < src.length && !src.startsWith(q, j)) {
        if (src[j] === '\\') j++
        else if (src[j] === '\n' && q.length === 1 && !(syntax.multiline ?? '').includes(c)) break
        j++
      }
      if (!keepStrings) wipe(i + q.length, j)
      i = j + q.length
      continue
    }
    i++
  }
  return out.join('')
}

/** Push a dep unless the file already has one to that target, or it points at itself. */
export function addDep(out: Map<string, Dep[]>, from: string, to: string, line: string): void {
  if (to === from) return
  const list = out.get(from) ?? out.set(from, []).get(from)!
  if (!list.some((d) => d.to === to)) list.push({ to, line })
}

/**
 * Find repo files by the end of their path: `lookup('a/b.h')` returns every file that is `a/b.h` or ends in
 * `/a/b.h`. Built once per snapshot for the files a resolver cares about.
 */
export class SuffixIndex {
  private map = new Map<string, string[]>()

  constructor(files: Iterable<string>) {
    for (const f of files) {
      const segs = f.split('/')
      for (let i = 0; i < segs.length; i++) {
        const key = segs.slice(i).join('/')
        const list = this.map.get(key) ?? this.map.set(key, []).get(key)!
        list.push(f)
      }
    }
  }

  lookup(suffix: string): string[] {
    return this.map.get(path.normalize(suffix).replace(/^\.\//, '')) ?? []
  }

  /** The match closest to `from`: the one sharing the longest leading folders with it, then the shortest. */
  nearest(suffix: string, from: string): string | undefined {
    const hits = this.lookup(suffix)
    if (hits.length <= 1) return hits[0]
    const shared = (a: string) => {
      const x = a.split('/')
      const y = from.split('/')
      let n = 0
      while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++
      return n
    }
    return hits.slice().sort((a, b) => shared(b) - shared(a) || a.length - b.length)[0]
  }
}

/** `path.join` that stays inside the repo: undefined when `..` climbs above the root. */
export function joinIn(dir: string, rel: string): string | undefined {
  const p = path.normalize(path.join(dir || '.', rel))
  return p.startsWith('..') ? undefined : p.replace(/^\.\//, '')
}
