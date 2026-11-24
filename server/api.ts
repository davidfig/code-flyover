// The app's local API: which repos you've added, their branches, analyses made on demand, and the AI change
// descriptions and reviews an outside AI saved (`flyover import`). It never calls a model. Served by Vite (vite.config.ts), both for `npm run dev` and for
// the `flyover` command (bin/flyover.mjs). Everything is read from git commits on this machine, except pull request
// numbers (server/prs.ts), which the page asks for only when that setting is on.
//
// GET    /api/repos                                   the repos you've added
// POST   /api/repos      { path }                     add one (any folder inside a git repo)
// DELETE /api/repos?repo=<id>                         forget one (nothing in the repo is touched)
// GET    /api/branches?repo=<id>                      its local branches, newest first, and the default base
// GET    /api/prs?repo=<id>                           its branches' GitHub pull request numbers (asks GitHub, through git)
// GET    /api/analysis?repo=<id>&head=<ref>&base=<ref> the analysis (made now, or from memory), with saved descriptions and review
// GET    /api/texts?repo=<id>&sha=<commit>            the text of every file the map can show at that commit (Whole repo)
// GET    /api/saved?repo=<id>&head=<ref>&base=<ref>    its saved descriptions, review and repo notes alone (the page checks for new ones)
// GET    /api/commits?repo=<id>&head=<ref>&base=<ref>  the commits the analysis would read now (the page checks for new ones)
// POST   /api/log        { message }                  the page's uncaught errors, printed to the server's output
// GET    /api/settings                                the settings every window shares (web/settingsStore.ts), or null
// PUT    /api/settings   { codeFlyoverSettings, settings }  saves them
// POST   /api/settings/export?path=<file.json>        writes the body (an exported settings file) where the save panel said
//
// State lives in ~/.code-flyover: repos.json, settings.json, notes/<repo id>.json (server/notes.ts), descriptions/<repo id>/<head>..<base>.json and reviews/<repo id>/<head>..<base>.json
// (AI-written, so they're kept; analyses take about a second, so they're only kept in memory). Descriptions and
// reviews can also come from an outside AI, through `flyover export` and `import` (server/review-cli.ts).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze, onMap } from '../analyzer/analyze.ts'
import { listFiles, readFiles, snapshot } from '../analyzer/git.ts'
import { notesAt } from './notes.ts'
import { pullNumbers } from './prs.ts'
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
  /** that worktree has uncommitted changes (shown with the branch's commits) */
  dirty?: boolean
}

const STATE = path.join(os.homedir(), '.code-flyover')
// The app was called Semantic Zoom and kept its state in ~/.semantic-zoom: move over whatever the new folder lacks,
// then remove the old one once it's empty.
const OLD_STATE = path.join(os.homedir(), '.semantic-zoom')
if (fs.existsSync(OLD_STATE)) {
  fs.mkdirSync(STATE, { recursive: true })
  for (const name of fs.readdirSync(OLD_STATE)) {
    const to = path.join(STATE, name)
    if (!fs.existsSync(to)) fs.renameSync(path.join(OLD_STATE, name), to)
  }
  if (fs.readdirSync(OLD_STATE).length === 0) fs.rmdirSync(OLD_STATE)
}
const REPOS_FILE = path.join(STATE, 'repos.json')
const SETTINGS_FILE = path.join(STATE, 'settings.json')
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

/** Where each branch is checked out: branch name → folder (the repo's own, or one of its worktrees). */
function worktrees(repo: Repo): Map<string, string> {
  const out = new Map<string, string>()
  let at = ''
  for (const line of git(repo.path, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice(9)
    else if (line.startsWith('branch refs/heads/')) out.set(line.slice(18), at)
  }
  return out
}

/** Whether a folder has uncommitted changes (--no-optional-locks: status mustn't write its index). */
const isDirty = (folder: string) => {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', folder, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''
  } catch {
    return false
  }
}

/** A worktree's last snapshot, kept a few seconds: the page polls, and an unchanged folder needn't be snapshotted each time. */
const SNAPSHOT_TTL_MS = 3000
const snapshots = new Map<string, { at: number; sha: string | null }>()
function snapshotSoon(folder: string): string | null {
  const hit = snapshots.get(folder)
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.sha
  const sha = snapshot(folder) || null
  snapshots.set(folder, { at: Date.now(), sha })
  if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value!)
  return sha
}

/**
 * The commit to read as a branch's head: its tip, or, when it is checked out in a folder with uncommitted changes, a
 * snapshot of that folder's files (analyzer/git.ts), so the map shows the work as it is now.
 */
function headOf(repo: Repo, head: string): { sha: string; worktree?: string } {
  const sha = tryGit(repo.path, ['rev-parse', '--verify', head + '^{commit}'])
  if (!sha) throw new HttpError(404, `No branch or commit ${head} in ${repo.name}`)
  const folder = worktrees(repo).get(head)
  if (folder && fs.existsSync(folder)) {
    try {
      const snap = snapshotSoon(folder)
      if (snap) return { sha: snap, worktree: folder }
    } catch (e) {
      console.error(`Couldn't read the uncommitted changes in ${folder}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return { sha }
}

/** The commit a branch is compared at: where it left the base (as the analysis does). */
const mergeBaseOf = (repo: Repo, base: string, headSha: string) => {
  const baseSha = tryGit(repo.path, ['rev-parse', '--verify', base + '^{commit}'])
  if (!baseSha) throw new HttpError(404, `No branch or commit ${base} in ${repo.name}`)
  return tryGit(repo.path, ['merge-base', baseSha, headSha]) ?? baseSha
}

export function branches(repo: Repo): { base: string; branches: Branch[] } {
  const base = defaultBase(repo.path)
  const checkedOut = worktrees(repo)
  const list: Branch[] = []
  const out = git(repo.path, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)', 'refs/heads'])
  for (const line of out.split('\n')) {
    if (!line) continue
    const [name, sha, date, ...subject] = line.split('\t')
    list.push({ name, sha, date, subject: subject.join('\t'), ahead: 0, behind: 0, worktree: checkedOut.get(name) })
    if (list.length >= MAX_BRANCHES) break
  }
  for (const b of list) {
    if (b.worktree) b.dirty = isDirty(b.worktree)
    const counts = tryGit(repo.path, ['rev-list', '--left-right', '--count', `${base}...${b.sha}`])
    if (counts) [b.behind, b.ahead] = counts.split(/\s+/).map(Number)
  }
  // The base's own local branch (main) is listed too: it may carry unpushed or uncommitted work, and even without
  // any it opens as a map of the whole repo. With nothing of its own it goes last, so a working branch opens first.
  const baseName = base.replace(/^origin\//, '')
  const idle = (b: Branch) => b.name === baseName && !b.ahead && !b.dirty
  list.sort((x, y) => Number(idle(x)) - Number(idle(y)))
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

/** Past this a file's text isn't sent: a generated or vendored file no one reads on the map. */
const MAX_TEXT_BYTES = 512 * 1024
/** The code and doc files at a commit (as the analysis puts them on the map), with their text, kept for the last few commits. */
const textCache = new Map<string, Map<string, string>>()
function codeTexts(repo: Repo, sha: string): Map<string, string> {
  const key = `${repo.id}:${sha}`
  let texts = textCache.get(key)
  if (!texts) {
    texts = readFiles(repo.path, sha, listFiles(repo.path, sha).filter(onMap))
    for (const [p, t] of texts) if (t.length > MAX_TEXT_BYTES || t.includes('\0')) texts.delete(p)
    textCache.set(key, texts)
    if (textCache.size > 4) textCache.delete(textCache.keys().next().value!)
  }
  return texts
}

export function analysisFor(repo: Repo, head: string, base: string): Analysis {
  const at = headOf(repo, head)
  const baseSha = mergeBaseOf(repo, base, at.sha)
  // The stored analysis carries the head and base names and an id made from them, so they're part of the key.
  const key = JSON.stringify([repo.id, head, base, at.sha, baseSha])
  let a = cache.get(key)
  if (!a) {
    a = { ...analyze({ repo: repo.path, head, base, modelsDir: MODELS_DIR, id: `${repo.id}--${head}`, at: at.sha }), ...(at.worktree ? { uncommitted: at.worktree } : {}) }
    cache.set(key, a)
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  }
  // Saved descriptions and review, even for an older commit of the branch: the panel says so.
  return { ...a, changes: savedDescriptions(repo, head, base), review: savedReview(repo, head, base), notes: notesAt(repo.id, repo.path, a.headSha) }
}

/** Saves descriptions an outside AI wrote (`flyover import`) where the app looks for them. */
export function saveDescriptions(repoPath: string, head: string, base: string, cs: ChangeSet) {
  writeJson(descriptionFile(addRepo(repoPath), head, base), cs)
}

/** Saves an outside AI's review (`flyover import`) where the app looks for it. */
export function saveReview(repoPath: string, head: string, base: string, review: Review) {
  writeJson(reviewFile(addRepo(repoPath), head, base), review)
}

export function loadReview(repoPath: string, head: string, base: string): Review | undefined {
  return savedReview(addRepo(repoPath), head, base)
}

export function loadDescriptions(repoPath: string, head: string, base: string): ChangeSet | undefined {
  return savedDescriptions(addRepo(repoPath), head, base)
}

// ---------- HTTP ----------

/** A body as text, up to `max` bytes: past that, stops reading and rejects once with a 413. */
const rawBody = (req: IncomingMessage, max = 1 << 20): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > max) {
        done = true
        chunks.length = 0
        req.pause() // stop reading; the 413 closes the connection (see handle)
        reject(new HttpError(413, 'Too big'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })

const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = await rawBody(req)
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const isLoopback = (addr?: string) => !!addr && (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('::ffff:127.'))

/**
 * Every API request must come from the app's own page, or from a program on this machine (the `flyover` command's
 * curl-like POST). A web page on another site or another localhost port must not be able to read repo contents or
 * change anything, so:
 *  - the connection is from loopback and the Host is localhost or 127.0.0.1 (a rebound DNS name fails this);
 *  - a browser says where the page came from: Sec-Fetch-Site must be same-origin, and an Origin must be exactly this
 *    server's own (http://<Host>), or the desktop webview's tauri://localhost. A different port is a different origin;
 *  - a request with neither header is not from a browser's page, so it is allowed (bin/flyover.mjs, curl). Anything
 *    that writes files (`strict`) wants the browser's Origin, and a JSON body (so a "simple" cross-site form can't send it).
 * Vite answers CORS preflights for localhost origins, so the checks here, not the preflight, are what refuse.
 */
const fromApp = (req: IncomingMessage, strict = false) => {
  const host = req.headers.host ?? ''
  if (!isLoopback(req.socket.remoteAddress) || !LOOPBACK_HOST.test(host)) throw new HttpError(403, 'Not from the app')
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin') throw new HttpError(403, 'Not from the app')
  const origin = req.headers.origin
  if (origin && origin !== `http://${host}` && origin !== 'tauri://localhost') throw new HttpError(403, 'Not from the app')
  if (strict && !origin) throw new HttpError(403, 'Not from the app')
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE'
  if ((strict || hasBody) && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON')
}

/** Where an exported settings file may go: a new or existing settings .json in the user's home folder, outside hidden folders. */
function exportTarget(raw: string): string {
  const home = fs.realpathSync(os.homedir())
  const file = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()))
  if (!file.toLowerCase().endsWith('.json')) throw new HttpError(400, 'Settings are exported as a .json file')
  let dir: string
  try {
    dir = fs.realpathSync(path.dirname(file))
  } catch {
    throw new HttpError(400, `No folder ${path.dirname(file)}`)
  }
  const rel = path.relative(home, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, 'Settings can only be exported inside your home folder')
  if (rel.split(path.sep).some((part) => part.startsWith('.'))) throw new HttpError(403, 'Settings can\'t be exported into a hidden folder')
  const target = path.join(dir, path.basename(file))
  let st: fs.Stats | undefined
  try {
    st = fs.lstatSync(target)
  } catch {}
  if (st) {
    if (!st.isFile()) throw new HttpError(409, `${target} isn't a plain file`)
    try {
      settingsDoc(fs.readFileSync(target, 'utf8'))
    } catch {
      throw new HttpError(409, `${target} exists and isn't a settings file: pick another name`)
    }
  }
  return target
}

/** A settings document as the page sends it: an object with a `settings` object. */
const settingsDoc = (raw: string) => {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Not JSON')
  }
  const s = (doc as { settings?: unknown } | null)?.settings
  if (!doc || typeof doc !== 'object' || !s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, 'Not a settings document')
  return doc
}

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
    fromApp(req)
    // The page's uncaught errors, so they show in the server's output (the desktop app has no console to look at).
    if (route === 'POST /log') {
      const b = await body(req)
      console.error(`[page] ${String(b.message ?? '').slice(0, 4000)}`)
      return send(200, {})
    }
    if (route === 'GET /settings') {
      try {
        return send(200, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return send(200, null)
        throw new HttpError(500, `${SETTINGS_FILE} can't be read: ${e instanceof Error ? e.message : e}`)
      }
    }
    if (route === 'PUT /settings') {
      fromApp(req, true)
      writeJson(SETTINGS_FILE, settingsDoc(await rawBody(req)))
      return send(200, {})
    }
    if (route === 'POST /settings/export') {
      fromApp(req, true)
      const file = exportTarget(need(q.get('path'), 'path'))
      const doc = settingsDoc(await rawBody(req))
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
      return send(200, { path: file })
    }
    if (route === 'GET /repos') return send(200, readRepos())
    if (route === 'POST /repos') return send(200, addRepo(need((await body(req)).path, 'path')))
    if (route === 'DELETE /repos') {
      writeRepos(readRepos().filter((r) => r.id !== q.get('repo')))
      return send(200, readRepos())
    }
    if (route === 'GET /branches') return send(200, branches(repoById(q.get('repo'))))
    if (route === 'GET /prs') {
      const repo = repoById(q.get('repo'))
      return send(200, await pullNumbers(repo.path, branches(repo).branches))
    }
    if (route === 'GET /analysis') {
      const repo = repoById(q.get('repo'))
      return send(200, analysisFor(repo, need(q.get('head'), 'head'), need(q.get('base') ?? defaultBase(repo.path), 'base')))
    }
    if (route === 'GET /texts') {
      const repo = repoById(q.get('repo'))
      const sha = need(q.get('sha'), 'sha')
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new HttpError(400, `Not a commit: ${sha}`)
      return send(200, Object.fromEntries(codeTexts(repo, sha)))
    }
    if (route === 'GET /commits') {
      const repo = repoById(q.get('repo'))
      // As the analysis reads them: the head's snapshot when it has uncommitted changes, and the merge-base.
      const at = headOf(repo, need(q.get('head'), 'head'))
      return send(200, { head: at.sha, base: mergeBaseOf(repo, need(q.get('base') ?? defaultBase(repo.path), 'base'), at.sha) })
    }
    if (route === 'GET /saved') {
      const repo = repoById(q.get('repo'))
      const head = need(q.get('head'), 'head')
      const base = need(q.get('base') ?? defaultBase(repo.path), 'base')
      const at = headOf(repo, head)
      return send(200, { changes: savedDescriptions(repo, head, base) ?? null, review: savedReview(repo, head, base) ?? null, notes: notesAt(repo.id, repo.path, at.sha) })
    }
    send(404, { error: `No such API: ${route}` })
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) res.setHeader('Connection', 'close')
    send(e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) })
  }
}
