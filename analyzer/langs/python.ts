// Python: `import a.b`, `from a.b import c`, and relative `from ..x import y`, resolved to `.py` files and packages'
// `__init__.py`. An absolute import is looked up by path suffix, so it works whatever the source root is (the repo
// root, `src/`, a monorepo's `packages/x/`); the match nearest the importing file wins. Anything that isn't in the
// repo and isn't the standard library is a third-party package.

import path from 'node:path/posix'
import { languageById } from '../../shared/languages.ts'
import { addDep, blank, emptyDeps, joinIn, lineAt, SuffixIndex, type LangDeps, type Snapshot } from './common.ts'

const STDLIB = new Set(
  (
    '__future__ abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cmath cmd code codecs ' +
    'collections colorsys concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses ' +
    'datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ' +
    'ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ' +
    'ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc ' +
    'numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posix pprint profile pstats pty pwd ' +
    'py_compile pyclbr queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve ' +
    'shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess ' +
    'symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize ' +
    'tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref ' +
    'webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread'
  ).split(' '),
)

export const PY_EXT = /\.(py|pyi|pyw)$/

export function pythonDeps(snap: Snapshot): LangDeps {
  const out = emptyDeps()
  const pyFiles = [...snap.files].filter((f) => PY_EXT.test(f))
  if (!pyFiles.length) return out
  const index = new SuffixIndex(pyFiles)
  const syntax = languageById('python')!.syntax

  /**
   * A module path (`a/b/c`) to its file: the module itself, or the package's `__init__`. An absolute one has to
   * sit under a folder that could be on the importer's `sys.path`: one of its ancestors (the repo root included),
   * or a `src/` beside one, so a stray `requests.py` deep in the tree doesn't capture `import requests`.
   */
  const moduleFile = (rel: string, from: string, relative: boolean): string | undefined => {
    for (const cand of [rel + '.py', rel + '.pyi', rel + '/__init__.py', rel + '/__init__.pyi']) {
      if (relative) {
        if (snap.files.has(cand)) return cand
        continue
      }
      const hits = index.lookup(cand).filter((hit) => {
        const root = hit.slice(0, hit.length - cand.length)
        return from.startsWith(root) || (/(^|\/)src\/$/.test(root) && from.startsWith(root.replace(/src\/$/, '')))
      })
      if (hits.length) return hits.sort((a, b) => b.length - a.length)[0]
    }
    return undefined
  }

  for (const file of pyFiles) {
    const src = snap.contents.get(file)
    if (src === undefined) continue
    const clean = blank(src, syntax)
    const ext = new Set<string>()
    const add = (to: string | undefined, at: number) => to && addDep(out.deps, file, to, lineAt(src, at))
    const external = (top: string, at: number) => {
      if (!top || STDLIB.has(top) || ext.has(top)) return
      ext.add(top)
      const list = out.external.get(file) ?? out.external.set(file, []).get(file)!
      list.push({ to: top, line: lineAt(src, at) })
    }

    // from X import a, b   /   from X import (a,\n b)
    for (const m of clean.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
      const dots = m[1].length
      const mod = m[2] ? m[2].split('.') : []
      const names = m[3].replace(/[()\\]/g, ' ').split(',').map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && n !== '*')
      let base: string | undefined
      if (dots) {
        base = path.dirname(file) === '.' ? '' : path.dirname(file)
        for (let k = 1; k < dots && base !== undefined; k++) base = base ? joinIn(base, '..') : undefined
        if (base === undefined) continue
        if (base === '.') base = ''
      }
      const rel = (segs: string[]) => (dots ? joinIn(base!, segs.join('/') || '.') : segs.join('/'))
      const modPath = rel(mod)
      let hitAny = false
      // Each imported name may be a submodule of X; if not, it's something defined in X itself.
      for (const n of names) {
        const sub = rel([...mod, n])
        const f = sub ? moduleFile(sub, file, dots > 0) : undefined
        if (f) { add(f, m.index!); hitAny = true }
      }
      if (!hitAny) {
        let f: string | undefined
        if (!dots) f = moduleFile(modPath!, file, false)
        else if (mod.length) f = modPath === undefined ? undefined : moduleFile(modPath, file, true)
        else f = [base ? base + '/__init__.py' : '__init__.py'].find((c) => snap.files.has(c))
        if (f) add(f, m.index!)
        else if (!dots) external(mod[0], m.index!)
      }
    }

    // import a.b.c as x, d
    for (const m of clean.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+/)[0]
        if (!/^[\w.]+$/.test(name)) continue
        const segs = name.split('.')
        // `import a.b.c` loads a, a.b and a.b.c: the deepest one in the repo is what the file uses.
        let found: string | undefined
        for (let n = segs.length; n >= 1 && !found; n--) found = moduleFile(segs.slice(0, n).join('/'), file, false)
        if (found) add(found, m.index!)
        else external(segs[0], m.index!)
      }
    }
  }
  return out
}
