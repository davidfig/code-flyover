// Read-only git access. Everything is read from commits, so the repo's
// working tree (and other agents' uncommitted work) is never touched.
//
// Uncommitted work is read the same way: `snapshot` makes a commit of a worktree's files as they are, through an index
// of its own, that no branch points at. It adds objects to the repo's object store (git gc clears them once they're old)
// and changes nothing else: not the files, the worktree's index or any ref.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DiffLine, Hunk } from '../shared/types.ts'

export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
}

export function revParse(repo: string, rev: string): string {
  return git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]).trim()
}

export function mergeBase(repo: string, a: string, b: string): string {
  return git(repo, ['merge-base', a, b]).trim()
}

export function listFiles(repo: string, sha: string): string[] {
  return git(repo, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean)
}

/** Read many blobs at one commit in a single `git cat-file --batch` call. */
export function readFiles(repo: string, sha: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const input = paths.map((p) => `${sha}:${p}`).join('\n') + '\n'
  const res = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input, maxBuffer: 1 << 30 })
  if (res.status !== 0) throw new Error(`git cat-file failed: ${res.stderr.toString()}`)
  const buf = res.stdout
  let pos = 0
  for (const p of paths) {
    const nl = buf.indexOf(10, pos)
    const header = buf.subarray(pos, nl).toString()
    pos = nl + 1
    if (header.endsWith('missing')) continue
    const size = Number(header.split(' ')[2])
    out.set(p, buf.subarray(pos, pos + size).toString('utf8'))
    pos += size + 1
  }
  return out
}

export interface DiffFile {
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  path: string
  oldPath?: string
  add: number
  del: number
  hunks: Hunk[]
  binary: boolean
}

/** Parse `git diff` between two commits into files and hunks. */
export function diff(repo: string, base: string, head: string): DiffFile[] {
  const text = git(repo, ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base, head])
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let hunk: Hunk | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      cur = { status: 'modified', path: m ? m[2] : '', oldPath: m ? m[1] : undefined, add: 0, del: 0, hunks: [], binary: false }
      files.push(cur)
      hunk = null
      continue
    }
    if (!cur) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) cur.status = 'added'
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted'
      else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice(12) }
      else if (line.startsWith('rename to ')) cur.path = line.slice(10)
      else if (line.startsWith('Binary files')) cur.binary = true
      else if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') cur.path = line.slice(6) }
      else if (line.startsWith('--- ')) { if (line !== '--- /dev/null') cur.oldPath = line.slice(6) }
    }
    if (line.startsWith('@@')) {
      hunk = { header: line, lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const t = line[0]
    if (t === '+' || t === '-' || t === ' ') {
      hunk.lines.push({ t, s: line.slice(1) } as DiffLine)
      if (t === '+') cur.add++
      else if (t === '-') cur.del++
    }
  }
  for (const f of files) {
    if (f.status === 'modified' && f.oldPath === f.path) delete f.oldPath
    if (f.status === 'deleted' && f.oldPath) f.path = f.oldPath
  }
  return files
}

export function commits(repo: string, base: string, head: string): { sha: string; subject: string }[] {
  return git(repo, ['log', '--format=%h%x09%s', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split('\t')
      return { sha, subject: rest.join('\t') }
    })
}

/** The subject of a worktree's snapshot commit: how its uncommitted changes show among the branch's commits. */
export const UNCOMMITTED = 'Uncommitted changes'

/** Fixed, so a snapshot of the same files on the same commit is the same commit: its id says whether anything changed. */
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: 'Code Flyover',
  GIT_AUTHOR_EMAIL: 'code-flyover@localhost',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'Code Flyover',
  GIT_COMMITTER_EMAIL: 'code-flyover@localhost',
  GIT_COMMITTER_DATE: '@0 +0000',
}

/**
 * A commit of a worktree's files as they are now (tracked and untracked, less what .gitignore leaves out), on top of its
 * HEAD; null when it has no uncommitted changes. The same files give the same commit id.
 */
export function snapshot(worktree: string): string | null {
  // --no-optional-locks: a plain `git status` may write the worktree's index to refresh it.
  const status = execFileSync('git', ['--no-optional-locks', '-C', worktree, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 1 << 30 })
  if (!status.trim()) return null
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  // A copy of the worktree's index, so `add` only reads the files whose size or time changed.
  const own = run(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  const index = path.join(os.tmpdir(), `code-flyover-index-${process.pid}-${Math.random().toString(36).slice(2)}`)
  try {
    if (fs.existsSync(own)) fs.copyFileSync(own, index)
    run(['add', '-A'], { GIT_INDEX_FILE: index })
    const tree = run(['write-tree'], { GIT_INDEX_FILE: index })
    const head = run(['rev-parse', 'HEAD'])
    if (tree === run(['rev-parse', 'HEAD^{tree}'])) return null
    return run(['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', UNCOMMITTED], SNAPSHOT_ENV)
  } finally {
    fs.rmSync(index, { force: true })
  }
}
