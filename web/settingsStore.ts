// Where the settings (settings.ts) are kept, and their import and export. One JSON document:
//   { "codeFlyoverSettings": 1, "settings": { …every setting… } }
// It's a file, ~/.code-flyover/settings.json, read and written through the app's server (GET and PUT /api/settings),
// so the desktop app and any browser tab on the server share one set of settings, and the file can be edited or backed
// up like any other. A window picks up changes another one made when it comes to the front. Only a page with no server
// behind it falls back to the same document in this browser's IndexedDB.
// Export writes that document out; import reads one back (or a bare { "codeColumns": … } object), keeping what it can use.

import { defaults, KEYS, onSettingsChange, settings, update, type SettingKey } from './settings.ts'

export const FORMAT_VERSION = 1
export interface SettingsDoc {
  codeFlyoverSettings: number
  settings: Record<string, unknown>
}

interface TauriApi {
  dialog: { save(options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> }
}
const tauri = (window as unknown as { __TAURI__?: TauriApi }).__TAURI__

/** Whether the server answered: false only when the page has none behind it (then IndexedDB holds the settings). */
let server = true

/** Where the settings live: shown in the Settings dialog. */
export const storageName = () => (server ? '~/.code-flyover/settings.json' : 'this browser’s storage (IndexedDB)')

export function toDoc(): SettingsDoc {
  return { codeFlyoverSettings: FORMAT_VERSION, settings: Object.fromEntries(KEYS.map((k) => [k, settings[k]])) }
}

// ---------- IndexedDB (no server) ----------

// Named before the app became Code Flyover; kept so settings already in this browser are still found.
const DB = 'semantic-zoom'
const STORE = 'settings'
const DOC_KEY = 'settings'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

const idbRead = async () => (await idb<SettingsDoc | undefined>('readonly', (s) => s.get(DOC_KEY))) ?? null

// ---------- reading and writing ----------

/** The settings file (null: none yet). Throws when the server isn't there or can't read it. */
async function readFile(): Promise<SettingsDoc | null> {
  const res = await fetch('/api/settings', { cache: 'no-store' })
  const body = await res.json().catch(() => {
    throw new Error('No server')
  })
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`)
  return body as SettingsDoc | null
}

async function write(doc: SettingsDoc): Promise<void> {
  if (!server) {
    await idb('readwrite', (s) => s.put(doc, DOC_KEY))
    return
  }
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) })
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status} ${res.statusText}`)
}

/** What the settings were kept in before the file: the panel's width and the map's view options, in localStorage. */
function fromLocalStorage(): Record<string, unknown> {
  const old: Record<string, unknown> = {}
  try {
    const w = Number(localStorage.getItem('semantic-zoom:panelWidth'))
    if (w) old.panelWidth = w
    for (const k of ['showImpacted', 'dimUnchanged', 'showTests', 'showLocales', 'showUnchanged', 'showTiming']) {
      const v = localStorage.getItem('semantic-zoom:' + k)
      if (v !== null) old[k] = v === 'true'
    }
  } catch {}
  return old
}

/** While true, changes come from the file, so they aren't written straight back to it. */
let applying = false

/** Reads the stored settings into `settings` (without telling listeners: the page is starting). Never throws. */
export async function loadSettings(): Promise<void> {
  try {
    let doc: SettingsDoc | null
    try {
      doc = await readFile()
    } catch (e) {
      if (e instanceof Error && e.message === 'No server') {
        server = false
        doc = await idbRead()
      } else throw e
    }
    if (doc?.settings) update(doc.settings, false)
    else {
      // No file yet: start from what this browser kept before (IndexedDB, then localStorage), and write it.
      const old = server ? await idbRead().catch(() => null) : null
      update(old?.settings ?? fromLocalStorage(), false)
      void saveNow()
    }
  } catch (e) {
    console.warn('Settings could not be read; using the defaults.', e)
  }
  // Every change is saved, a moment later (a slider dragged saves once).
  onSettingsChange(() => !applying && scheduleSave())
  // Another window (the desktop app, a browser tab) may have changed the file: catch up on coming to the front.
  if (server)
    window.addEventListener('focus', async () => {
      try {
        const doc = await readFile()
        if (!doc?.settings) return
        applying = true
        try {
          update({ ...defaults(), ...doc.settings })
        } finally {
          applying = false
        }
      } catch {}
    })
}

let timer: ReturnType<typeof setTimeout> | undefined
let failed: ((e: unknown) => void) | null = null
/** Called when a save fails (the dialog shows it). */
export function onSaveError(fn: (e: unknown) => void) {
  failed = fn
}
function scheduleSave() {
  clearTimeout(timer)
  timer = setTimeout(() => void saveNow(), 300)
}
async function saveNow() {
  try {
    await write(toDoc())
  } catch (e) {
    console.error('Settings could not be saved', e)
    failed?.(e)
  }
}

/** Puts every setting back to its default. */
export function resetAll(): SettingKey[] {
  return update(defaults()).changed
}

// ---------- import and export ----------

/** Reads an exported settings file. Returns what was set, and what was in the file but couldn't be used. */
export function importText(text: string): { changed: SettingKey[]; rejected: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file isn’t JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('That file isn’t a settings file.')
  const obj = parsed as Record<string, unknown>
  // Files exported before the rename say "semanticZoomSettings".
  const version = obj.codeFlyoverSettings ?? obj.semanticZoomSettings
  const values = version !== undefined ? obj.settings : obj
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('That file has no settings in it.')
  if (typeof version === 'number' && version > FORMAT_VERSION) console.warn('Settings from a newer version: reading what this one knows.')
  return update(values as Record<string, unknown>)
}

const FILE_NAME = 'code-flyover-settings.json'

/**
 * Writes the settings out: in the desktop app, to a file picked in the save panel (the server writes it); in a
 * browser, as a download. Resolves with where it went, or null if cancelled.
 */
export async function exportSettings(): Promise<string | null> {
  const text = JSON.stringify(toDoc(), null, 2) + '\n'
  if (tauri) {
    const path = await tauri.dialog.save({ title: 'Export Settings', defaultPath: FILE_NAME, filters: [{ name: 'Settings', extensions: ['json'] }] })
    if (!path) return null
    const res = await fetch(`/api/settings/export?${new URLSearchParams({ path })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status} ${res.statusText}`)
    return path
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  a.download = FILE_NAME
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  return FILE_NAME
}
