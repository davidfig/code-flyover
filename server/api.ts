// The app's local API: which repos you've added, their branches, analyses made on demand, and the AI change
// descriptions and reviews an outside AI saved (`semantic-zoom import`). It never calls a model. Served by Vite (vite.config.ts), both for `npm run dev` and for
// the `semantic-zoom` command (bin/semantic-zoom.mjs). Everything is read from git commits on this machine.
//
// GET    /api/repos                                   the repos you've added
// POST   /api/repos      { path }                     add one (any folder inside a git repo)
// DELETE /api/repos?repo=<id>                         forget one (nothing in the repo is touched)
// GET    /api/branches?repo=<id>                      its local branches, newest first, and the default base
// GET    /api/analysis?repo=<id>&head=<ref>&base=<ref> the analysis (made now, or from memory), with saved descriptions and review
// GET    /api/saved?repo=<id>&head=<ref>&base=<ref>    its saved descriptions and review alone (the page checks for new ones)
// GET    /api/commits?repo=<id>&head=<ref>&base=<ref>  the commits head and base are at now (the page checks for new ones)
// POST   /api/log        { message }                  the page's uncaught errors, printed to the server's output
//
// State lives in ~/.semantic-zoom: repos.json, descriptions/<repo id>/<head>..<base>.json and reviews/<repo id>/<head>..<base>.json
// (AI-written, so they're kept; analyses take about a second, so they're only kept in memory). Descriptions and
// reviews can also come from an outside AI, through `semantic-zoom export` and `import` (server/review-cli.ts).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../analyzer/analyze.ts'
import type { Analysis, ChangeSet, Review } from '../shared/types.ts'

export interface Repo {
  id: string
  name: string
  path: string
}

export interface Branch {
  name: string
  sha: string
  /** committer date of its tip, ISO */
  date: string
  subject: string
  /** commits on it that aren't on the default base, and on the base that aren't on it */
  ahead: number
  behind: number
  /** checked out in this worktree (the repo's own folder, or one of its worktrees) */
  worktree?: string
}

const STATE = path.join(os.homedir(), '.semantic-zoom')
const REPOS_FILE = path.join(STATE, 'repos.json')
const DESCRIPTIONS = path.join(STATE, 'descriptions')
const REVIEWS = path.join(STATE, 'reviews')
const MODELS_DIR = fileURLToPath(new URL('../models/', import.meta.url))
/** Branches listed with ahead/behind counts (each costs a git call): the most recent ones. */
const MAX_BRANCHES = 60
/** Analyses kept in memory. */
const MAX_CACHED = 8

const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
const tryGit = (repo: string, args: string[]) => {
  try {
    return git(repo, args).trim()
  } catch {
    return null
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// ---------- repos ----------

function readRepos(): Repo[] {
  try {
    return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'))
  } catch {
    return []
  }
}

function writeRepos(list: Repo[]) {
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(REPOS_FILE, JSON.stringify(list, null, 2))
}

/** A repo's id: its folder name and a hash of its path, so two clones with the same name stay apart. */
const repoId = (root: string) => `${path.basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 6)}`

export function addRepo(folder: string): Repo {
  const abs = path.resolve(folder.replace(/^~(?=$|\/)/, os.homedir()))
  if (!fs.existsSync(abs)) throw new HttpError(400, `No folder at ${abs}`)
  // A worktree's top level is its own folder; the repo it belongs to is where its shared .git lives.
  const common = tryGit(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) throw new HttpError(400, `${abs} isn't inside a git repository`)
  const root = path.basename(common) === '.git' ? path.dirname(common) : common
  const list = readRepos()
  let repo = list.find((r) => r.path === root)
  if (!repo) {
    repo = { id: repoId(root), name: path.basename(root), path: root }
    writeRepos([...list, repo].sort((a, b) => a.name.localeCompare(b.name)))
  }
  return repo
}

function repoById(id: string | null): Repo {
  const repo = readRepos().find((r) => r.id === id)
  if (!repo) throw new HttpError(404, `No repo ${id}: add it first`)
  if (!fs.existsSync(repo.path)) throw new HttpError(410, `${repo.path} is gone. Remove it from the list, or add it again where it moved to.`)
  return repo
}

// ---------- branches ----------

/** What a branch is compared with by default: the remote's default branch, else a local main or master. */
export function defaultBase(repo: string): string {
  const remote = tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (remote) return remote
  for (const b of ['origin/main', 'origin/master', 'main', 'master']) if (tryGit(repo, ['rev-parse', '--verify', '--quiet', b + '^{commit}'])) return b
  return 'HEAD'
}

export function branches(repo: Repo): { base: string; branches: Branch[] } {
  const base = defaultBase(repo.path)
  const worktrees = new Map<string, string>()
  let at = ''
  for (const line of git(repo.path, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice(9)
    else if (line.startsWith('branch refs/heads/')) worktrees.set(line.slice(18), at)
  }
  const baseName = base.replace(/^origin\//, '')
  const list: Branch[] = []
  const out = git(repo.path, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)', 'refs/heads'])
  for (const line of out.split('\n')) {
    if (!line) continue
    const [name, sha, date, ...subject] = line.split('\t')
    if (name === baseName || name === base) continue // the base itself has nothing to show
    list.push({ name, sha, date, subject: subject.join('\t'), ahead: 0, behind: 0, worktree: worktrees.get(name) })
    if (list.length >= MAX_BRANCHES) break
  }
  for (const b of list) {
    const counts = tryGit(repo.path, ['rev-list', '--left-right', '--count', `${base}...${b.sha}`])
    if (counts) [b.behind, b.ahead] = counts.split(/\s+/).map(Number)
  }
  return { base, branches: list }
}

// ---------- analyses and descriptions ----------

const cache = new Map<string, Analysis>()

const storeFile = (dir: string, repo: Repo, head: string, base: string) =>
  path.join(dir, repo.id, `${encodeURIComponent(head)}..${encodeURIComponent(base)}.json`)
const descriptionFile = (repo: Repo, head: string, base: string) => storeFile(DESCRIPTIONS, repo, head, base)
const reviewFile = (repo: Repo, head: string, base: string) => storeFile(REVIEWS, repo, head, base)

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

const savedDescriptions = (repo: Repo, head: string, base: string) => readJson<ChangeSet>(descriptionFile(repo, head, base))
const savedReview = (repo: Repo, head: string, base: string) => readJson<Review>(reviewFile(repo, head, base))

export function analysisFor(repo: Repo, head: string, base: string): Analysis {
  const headSha = tryGit(repo.path, ['rev-parse', '--verify', head + '^{commit}'])
  if (!headSha) throw new HttpError(404, `No branch or commit ${head} in ${repo.name}`)
  const baseSha = tryGit(repo.path, ['rev-parse', '--verify', base + '^{commit}'])
  if (!baseSha) throw new HttpError(404, `No branch or commit ${base} in ${repo.name}`)
  const key = `${repo.id} ${headSha} ${baseSha}`
  let a = cache.get(key)
  if (!a) {
    a = analyze({ repo: repo.path, head, base, modelsDir: MODELS_DIR, id: `${repo.id}--${head}` })
    cache.set(key, a)
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  }
  // Saved descriptions and review, even for an older commit of the branch: the panel says so.
  return { ...a, changes: savedDescriptions(repo, head, base), review: savedReview(repo, head, base) }
}

/** Saves descriptions an outside AI wrote (`semantic-zoom import`) where the app looks for them. */
export function saveDescriptions(repoPath: string, head: string, base: string, cs: ChangeSet) {
  writeJson(descriptionFile(addRepo(repoPath), head, base), cs)
}

/** Saves an outside AI's review (`semantic-zoom import`) where the app looks for it. */
export function saveReview(repoPath: string, head: string, base: string, review: Review) {
  writeJson(reviewFile(addRepo(repoPath), head, base), review)
}

export function loadDescriptions(repoPath: string, head: string, base: string): ChangeSet | undefined {
  return savedDescriptions(addRepo(repoPath), head, base)
}

// ---------- HTTP ----------

const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const need = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `Missing ${name}`)
  // Branch names and refs only: never options to git.
  if (name !== 'path' && v.startsWith('-')) throw new HttpError(400, `Bad ${name}`)
  return v
}

/** Handles /api/* (the URL's path after /api). */
export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const q = url.searchParams
  const route = `${req.method} ${url.pathname.replace(/^\/api/, '')}`
  const send = (status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(data))
  }
  try {
    // The page's uncaught errors, so they show in the server's output (the desktop app has no console to look at).
    if (route === 'POST /log') {
      const b = await body(req)
      console.error(`[page] ${String(b.message ?? '').slice(0, 4000)}`)
      return send(200, {})
    }
    if (route === 'GET /repos') return send(200, readRepos())
    if (route === 'POST /repos') return send(200, addRepo(need((await body(req)).path, 'path')))
    if (route === 'DELETE /repos') {
      writeRepos(readRepos().filter((r) => r.id !== q.get('repo')))
      return send(200, readRepos())
    }
    if (route === 'GET /branches') return send(200, branches(repoById(q.get('repo'))))
    if (route === 'GET /analysis') {
      const repo = repoById(q.get('repo'))
      return send(200, analysisFor(repo, need(q.get('head'), 'head'), need(q.get('base') ?? defaultBase(repo.path), 'base')))
    }
    if (route === 'GET /commits') {
      const repo = repoById(q.get('repo'))
      const at = (ref: string) => tryGit(repo.path, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'])
      return send(200, { head: at(need(q.get('head'), 'head')), base: at(need(q.get('base') ?? defaultBase(repo.path), 'base')) })
    }
    if (route === 'GET /saved') {
      const repo = repoById(q.get('repo'))
      const head = need(q.get('head'), 'head')
      const base = need(q.get('base') ?? defaultBase(repo.path), 'base')
      return send(200, { changes: savedDescriptions(repo, head, base) ?? null, review: savedReview(repo, head, base) ?? null })
    }
    send(404, { error: `No such API: ${route}` })
  } catch (e) {
    send(e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) })
  }
}
