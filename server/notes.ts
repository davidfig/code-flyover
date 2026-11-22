// What each file and folder in a repo is, in a sentence: the repo's own notes, shown on hovering a name on the map.
//
// They belong to the repo, not to a branch: what a file is doesn't change from branch to branch. Each note is tied to
// what it was written from, so it can't quietly go out of date:
//  - a file's note to the file's contents (its git blob). When the file changes, the note is marked out of date until
//    it's written again;
//  - a folder's note to what's in the folder (the names of its files and subfolders). Edits to the files leave it
//    alone; adding, removing or renaming one marks it out of date.
//
// Written by an outside AI through `flyover describe` and `flyover import` (server/review-cli.ts), and by a branch
// review's "what it is" lines (so those aren't written again for every branch). Kept in ~/.code-flyover/notes/<repo id>.json.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { git } from '../analyzer/git.ts'
import type { RepoNote, RepoNotes } from '../shared/types.ts'

interface Stored {
  about: string
  by: string
  /** when it was written, ISO */
  at: string
}

interface NotesFile {
  /** path → note, with the blob it describes */
  files: Record<string, Stored & { blob: string }>
  /** path → note, with the key of the folder's contents it describes (folderKeys) */
  folders: Record<string, Stored & { key: string }>
}

const NOTES = path.join(os.homedir(), '.code-flyover', 'notes')
const notesFile = (repoId: string) => path.join(NOTES, `${repoId}.json`)

function read(repoId: string): NotesFile {
  try {
    const f = JSON.parse(fs.readFileSync(notesFile(repoId), 'utf8'))
    return { files: f.files ?? {}, folders: f.folders ?? {} }
  } catch {
    return { files: {}, folders: {} }
  }
}

function write(repoId: string, data: NotesFile) {
  fs.mkdirSync(NOTES, { recursive: true })
  const file = notesFile(repoId)
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1))
  fs.renameSync(file + '.tmp', file)
}

/** Every file at a commit, with its blob (one `git ls-tree` call). */
export function blobsAt(repoPath: string, sha: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of git(repoPath, ['ls-tree', '-r', '-z', sha]).split('\0')) {
    // "<mode> <type> <blob>\t<path>"
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [, type, blob] = entry.slice(0, tab).split(' ')
    if (type === 'blob') out.set(entry.slice(tab + 1), blob)
  }
  return out
}

/** Each folder at a commit, keyed by what's in it: the names of its files and subfolders, hashed. */
export function folderKeys(paths: Iterable<string>): Map<string, string> {
  const entries = new Map<string, Set<string>>()
  for (const p of paths) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      let set = entries.get(dir)
      if (!set) entries.set(dir, (set = new Set()))
      set.add(i === parts.length - 1 ? parts[i] : parts[i] + '/')
    }
  }
  const out = new Map<string, string>()
  for (const [dir, set] of entries) out.set(dir, createHash('sha1').update([...set].sort().join('\n')).digest('hex').slice(0, 16))
  return out
}

/** The notes for the files and folders at a commit, each marked when it was written for other contents. Kept for the last few commits. */
const memo = new Map<string, RepoNotes>()
export function notesAt(repoId: string, repoPath: string, sha: string): RepoNotes {
  let mtime = 0
  try {
    mtime = fs.statSync(notesFile(repoId)).mtimeMs
  } catch {
    return { files: {}, folders: {} }
  }
  const key = `${repoId}:${sha}:${mtime}`
  const hit = memo.get(key)
  if (hit) return hit
  const saved = read(repoId)
  const blobs = blobsAt(repoPath, sha)
  const keys = folderKeys(blobs.keys())
  const out: RepoNotes = { files: {}, folders: {} }
  const note = (s: Stored, fresh: boolean): RepoNote => ({ about: s.about, by: s.by, ...(fresh ? {} : { stale: true as const }) })
  for (const [p, s] of Object.entries(saved.files)) if (blobs.has(p)) out.files[p] = note(s, blobs.get(p) === s.blob)
  for (const [p, s] of Object.entries(saved.folders)) if (keys.has(p)) out.folders[p] = note(s, keys.get(p) === s.key)
  memo.set(key, out)
  while (memo.size > 6) memo.delete(memo.keys().next().value!)
  return out
}

/** Which files and folders already have a note that's current at this commit. */
export function describedAt(repoId: string, repoPath: string, sha: string): { files: Set<string>; folders: Set<string> } {
  const n = notesAt(repoId, repoPath, sha)
  const fresh = (r: Record<string, RepoNote>) => new Set(Object.entries(r).filter(([, v]) => !v.stale).map(([p]) => p))
  return { files: fresh(n.files), folders: fresh(n.folders) }
}

/**
 * Saves notes written at a commit: each tied to the file's blob or the folder's contents there. A path that isn't a
 * file (or folder) at that commit is skipped and returned, as is an empty note.
 */
export function saveNotes(repoId: string, repoPath: string, sha: string, by: string, files: Record<string, string>, folders: Record<string, string>): { files: number; folders: number; skipped: string[] } {
  const blobs = blobsAt(repoPath, sha)
  const keys = folderKeys(blobs.keys())
  const data = read(repoId)
  const at = new Date().toISOString()
  const skipped: string[] = []
  let nf = 0
  let nd = 0
  for (const [p, about] of Object.entries(files)) {
    const blob = blobs.get(p)
    if (!blob || !about.trim()) skipped.push(p)
    else (data.files[p] = { about: about.trim(), by, at, blob }), nf++
  }
  for (const [p, about] of Object.entries(folders)) {
    const key = keys.get(p)
    if (!key || !about.trim()) skipped.push(p + '/')
    else (data.folders[p] = { about: about.trim(), by, at, key }), nd++
  }
  if (nf || nd) write(repoId, data)
  return { files: nf, folders: nd, skipped }
}
