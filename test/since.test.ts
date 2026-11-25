// Reviewing a branch from one of its commits on (git.startBefore): what the diff holds.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { branchCommits, diff, mergeBase, startBefore } from '../analyzer/git.ts'

function repo(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyover-since-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (file: string, text: string, message = file) => {
    fs.writeFileSync(path.join(dir, file), text)
    git('add', '-A')
    git('commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-qb', 'main')
  commit('shared.ts', 'one\n')
  git('checkout', '-qb', 'work')
  return { dir, git, commit }
}

const changed = (dir: string, from: string) => diff(dir, from, 'work').map((f) => f.path).sort()

test('shows the commit picked and everything after it, as it is at the head', (t) => {
  const { dir, commit } = repo(t)
  commit('a.ts', 'a\n')
  const b = commit('b.ts', 'b\n')
  commit('c.ts', 'c\n')
  commit('b.ts', 'b\nmore\n')
  const start = startBefore(dir, b, mergeBase(dir, 'main', 'work'))!
  assert.deepEqual(changed(dir, start.sha), ['b.ts', 'c.ts'])
  assert.equal(diff(dir, start.sha, 'work').find((f) => f.path === 'b.ts')!.add, 2)
})

test('leaves out what a later merge brought in from the base', (t) => {
  const { dir, git, commit } = repo(t)
  commit('a.ts', 'a\n')
  const b = commit('b.ts', 'b\n')
  git('checkout', '-q', 'main')
  commit('upstream.ts', 'u\n')
  git('checkout', '-q', 'work')
  git('merge', '-q', '--no-edit', 'main')
  commit('c.ts', 'c\n')
  const base = mergeBase(dir, 'main', 'work')
  const start = startBefore(dir, b, base)!
  assert.equal(start.mixed, undefined)
  assert.deepEqual(changed(dir, start.sha), ['b.ts', 'c.ts'])
  assert.deepEqual(startBefore(dir, b, base), start) // the same commit every time: the page's live check compares them
  assert.equal(branchCommits(dir, base, 'work').length, 4) // a, b, the merge, c
})

test('says so when that merge conflicts', (t) => {
  const { dir, git, commit } = repo(t)
  commit('shared.ts', 'work\n', 'edit shared')
  const b = commit('b.ts', 'b\n')
  git('checkout', '-q', 'main')
  commit('shared.ts', 'main\n', 'edit shared too')
  git('checkout', '-q', 'work')
  git('merge', '-q', '-s', 'ours', '--no-edit', 'main')
  assert.equal(startBefore(dir, b, mergeBase(dir, 'main', 'work'))!.mixed, true)
})

test('a commit with no parent has nothing to start from', (t) => {
  const { dir, git } = repo(t)
  const root = git('rev-parse', 'HEAD')
  assert.equal(startBefore(dir, root, root), null)
})
