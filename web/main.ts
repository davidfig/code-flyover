import type { Analysis, ChangeSet, Finding, RepoNotes, Review } from '../shared/types.ts'
import { esc, ZoomMap, type Level } from './map.ts'
import { roleOf, type MapNode } from './layout.ts'
import { picker, type Picker } from './picker.ts'
import { isNamedKey, shortcutLabel, shortcutOf } from './keys.ts'
import { DEFS, LAYOUT_KEYS, onSettingsChange, settings, SHORTCUT_KEYS, update, type SettingKey } from './settings.ts'
import { loadSettings } from './settingsStore.ts'
import { openSettings } from './settingsDialog.ts'
import { openWhatsNew } from './whatsNew.ts'
import { checkForUpdates, installUpdates, type TauriUpdates } from './updates.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T


let analysis: Analysis
let map: ZoomMap
let activeFinding = -1
const PANEL_MIN = 260

/** The side panel's width: dragged with the divider (or arrow keys), kept as the Side panel width setting. */
function setupSplitter() {
  const panel = $('#panel')
  const splitter = $('#splitter')
  const clamp = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, window.innerWidth * 0.7)))
  const apply = (w: number, save: boolean) => {
    const width = clamp(w)
    panel.style.width = width + 'px'
    splitter.setAttribute('aria-valuenow', String(width))
    if (save) update({ panelWidth: width })
  }
  apply(settings.panelWidth, false)
  onSettingsChange((changed) => changed.includes('panelWidth') && apply(settings.panelWidth, false))
  // The panel's text size: its CSS is in fixed px around 13px body text, so its content is scaled as a whole.
  const body = $('#panel-body')
  const textSize = () => (body.style.zoom = String(settings.panelTextPx / DEFS.panelTextPx.default))
  textSize()
  onSettingsChange((changed) => changed.includes('panelTextPx') && textSize())
  // The map's hover card: sized in em from this (style.css .file-tip).
  const tipSize = () => document.documentElement.style.setProperty('--tip-px', `${settings.tipTextPx}px`)
  tipSize()
  onSettingsChange((changed) => changed.includes('tipTextPx') && tipSize())
  splitter.setAttribute('aria-valuemin', String(PANEL_MIN))

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    splitter.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = panel.offsetWidth
    splitter.classList.add('dragging')
    document.body.classList.add('resizing')
    const move = (ev: PointerEvent) => apply(startW + (startX - ev.clientX), false)
    const up = (ev: PointerEvent) => {
      apply(startW + (startX - ev.clientX), true)
      splitter.classList.remove('dragging')
      document.body.classList.remove('resizing')
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
      splitter.removeEventListener('pointercancel', up)
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
    splitter.addEventListener('pointercancel', up)
  })
  splitter.addEventListener('dblclick', () => apply(DEFS.panelWidth.default, true))
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20
    if (e.key === 'ArrowLeft') apply(panel.offsetWidth + step, true)
    else if (e.key === 'ArrowRight') apply(panel.offsetWidth - step, true)
    else return
    e.preventDefault()
  })
  // Keep it within bounds when the window shrinks, and back to the setting when it grows again.
  window.addEventListener('resize', () => apply(settings.panelWidth, false))
}

// ---------- the desktop app (src-tauri) ----------

/** What the desktop app's window offers the page (Tauri's global API); undefined in a browser tab. */
interface TauriGlobal extends TauriUpdates {
  dialog: { open(options: { directory: boolean; title?: string; defaultPath?: string }): Promise<string | null> }
}
const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__

// ---------- repos and branches (server/api.ts) ----------

interface Repo { id: string; name: string; path: string }
interface Branch { name: string; sha: string; date: string; subject: string; ahead: number; behind: number; worktree?: string; dirty?: boolean }

let repos: Repo[] = []
/** What's open: from the URL's hash, #repo=<id>&head=<branch>&base=<ref> (base left out: the repo's default). */
let current: { repo: Repo; head: string; base: string } | null = null
let branchList: { repo: string; base: string; branches: Branch[] } | null = null
const LAST_REPO_KEY = 'semantic-zoom:lastRepo'

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init, headers: init?.body ? { 'Content-Type': 'application/json' } : undefined })
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

const hashState = () => new URLSearchParams(location.hash.slice(1))
function go(repo: string, head?: string, base?: string) {
  const p = new URLSearchParams({ repo })
  if (head) p.set('head', head)
  if (base) p.set('base', base)
  location.hash = p.toString()
}

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`
  return `${Math.round(s / (86400 * 30))}mo ago`
}

function panelMessage(html: string) {
  $('#panel-body').innerHTML = `<div class="empty">${html}</div>`
  wireAddRepo()
}

const addRepoButton = `<button type="button" class="add-repo">Add a repo…</button>`
function wireAddRepo() {
  document.querySelectorAll<HTMLButtonElement>('.add-repo').forEach((b) => (b.onclick = () => addRepo()))
}

async function addRepo() {
  // In the desktop app, the system's folder picker; in a browser, which can't hand out paths, type one.
  const folder = tauri
    ? await tauri.dialog.open({ directory: true, title: 'Open a repo (or any folder inside one)' })
    : window.prompt('Path to a git repo (or any folder inside one):', '~/Programming/')
  if (!folder) return renderRepoPicker()
  try {
    const repo = await api<Repo>('/api/repos', { method: 'POST', body: JSON.stringify({ path: folder }) })
    repos = await api<Repo[]>('/api/repos')
    go(repo.id)
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
    renderRepoPicker()
  }
}

async function removeRepo(repo: Repo) {
  if (!confirm(`Remove ${repo.name} from the list? (${repo.path} itself isn't touched.)`)) return renderRepoPicker()
  repos = await api<Repo[]>(`/api/repos?repo=${encodeURIComponent(repo.id)}`, { method: 'DELETE' })
  if (repos.length) go(repos[0].id)
  else {
    current = null
    location.hash = ''
    route()
  }
}

// The header's pickers (picker.ts), in place of the <span>s index.html holds for them.
const repoPicker = picker({
  label: 'Repo',
  groups: () => [{ items: repos.map((r) => ({ value: r.id, label: r.name, title: r.path })) }],
  commands: () => [
    { label: 'Add a repo…', run: () => void addRepo() },
    ...(current ? [{ label: `Remove ${current.repo.name} from the list`, run: () => current && void removeRepo(current.repo) }] : []),
  ],
  onPick: (id) => go(id),
})
const branchPicker = picker({
  label: 'Branch',
  groups: () => {
    if (!current || !branchList) return []
    const known = branchList.branches.some((b) => b.name === current!.head)
    return [{
      items: [
        ...(known ? [] : [{ value: current.head, label: current.head }]),
        ...branchList.branches.map((b) => ({
          value: b.name,
          label: b.name,
          badge: settings.showPrs && prs?.repo === current!.repo.id && prs.numbers[b.name] ? `#${prs.numbers[b.name]}` : undefined,
          detail: `${b.ahead} ahead · ${ago(b.date)}${b.worktree ? ' · checked out' : ''}`,
          title: `${b.subject}${b.worktree ? `\n${b.worktree}` : ''}`,
        })),
      ],
    }]
  },
  onPick: (name) => current && go(current.repo.id, name),
})
repoPicker.el.id = 'repo'
branchPicker.el.id = 'branch'
$('#repo').replaceWith(repoPicker.el)
$('#branch').replaceWith(branchPicker.el)

function renderRepoPicker() {
  repoPicker.set(current?.repo.id ?? '', current ? undefined : 'No repo')
}

function renderBranchPicker() {
  const ready = !!current && !!branchList && branchList.repo === current.repo.id
  branchPicker.disabled = !ready
  branchPicker.set(ready ? current!.head : '', ready ? undefined : '—')
}

async function loadBranches(repo: Repo) {
  const r = await api<{ base: string; branches: Branch[] }>(`/api/branches?repo=${encodeURIComponent(repo.id)}`)
  branchList = { repo: repo.id, ...r }
  void loadPrs(repo)
}

/** The branches' pull request numbers, when that setting is on: they come in after the list, which doesn't wait. */
let prs: { repo: string; numbers: Record<string, number> } | null = null
async function loadPrs(repo: Repo) {
  if (!settings.showPrs) return
  try {
    const numbers = await api<Record<string, number>>(`/api/prs?repo=${encodeURIComponent(repo.id)}`)
    if (current?.repo.id !== repo.id) return
    prs = { repo: repo.id, numbers }
    renderBranchPicker()
  } catch {} // no numbers
}

let routing = 0
/** Opens what the URL's hash names, filling in a repo and branch if it leaves them out. */
async function route() {
  const seq = ++routing
  const p = hashState()
  if (!repos.length) {
    current = null
    renderRepoPicker()
    renderBranchPicker()
    return panelMessage(`<h2>No repos yet</h2><p>Run <code>flyover</code> in a repo, or add one here.</p>${addRepoButton}`)
  }
  // A repo added since the list was read (`flyover` in a terminal, or a script): read the list again.
  if (p.get('repo') && !repos.some((r) => r.id === p.get('repo'))) {
    try {
      repos = await api<Repo[]>('/api/repos')
    } catch {}
    if (seq !== routing) return
    renderRepoPicker()
  }
  let lastRepo: string | null = null
  try { lastRepo = localStorage.getItem(LAST_REPO_KEY) } catch {}
  const repo = repos.find((r) => r.id === p.get('repo')) ?? repos.find((r) => r.id === lastRepo) ?? repos[0]
  if (p.get('repo') !== repo.id) return go(repo.id)
  try { localStorage.setItem(LAST_REPO_KEY, repo.id) } catch {}
  current = { repo, head: p.get('head') ?? '', base: p.get('base') ?? '' }
  renderRepoPicker()
  if (branchList?.repo !== repo.id) {
    renderBranchPicker()
    panelMessage(`<p>Reading ${esc(repo.name)}’s branches…</p>`)
    try {
      await loadBranches(repo)
    } catch (e) {
      return panelMessage(`<h2>Can't read ${esc(repo.name)}</h2><p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>${addRepoButton}`)
    }
    if (seq !== routing) return
  }
  if (!current.head) {
    const first = branchList!.branches[0]
    if (!first) {
      renderBranchPicker()
      return panelMessage(`<h2>Nothing to review in ${esc(repo.name)}</h2><p>It has no local branches.</p>`)
    }
    return go(repo.id, first.name)
  }
  current.base ||= branchList!.base
  renderBranchPicker()
  panelMessage(`<p>Analyzing <b>${esc(current.head)}</b> against <code>${esc(current.base)}</code>…</p>`)
  try {
    const a = await api<Analysis>(`/api/analysis?${new URLSearchParams({ repo: repo.id, head: current.head, base: current.base })}`)
    if (seq !== routing) return
    analysis = a
  } catch (e) {
    if (seq !== routing) return
    return panelMessage(`<h2>Couldn't analyze ${esc(current.head)}</h2><p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`)
  }
  map.load(analysis)
  if (document.activeElement === document.body) map.focusMap()
  syncScope()
  void fillWholeRepoText()
  renderPanel()
}

/**
 * A review or descriptions saved since the panel was drawn (`flyover import`, from a Claude Code session): shown
 * at once, without making the map again: your zoom and selection stay. Returns whether anything changed.
 */
async function showNewlySaved(): Promise<boolean> {
  if (!current || !analysis) return false
  const { repo, head, base } = current
  let s: { changes: ChangeSet | null; review: Review | null; notes?: RepoNotes }
  try {
    s = await api(`/api/saved?${new URLSearchParams({ repo: repo.id, head, base })}`)
  } catch {
    return false
  }
  if (current?.head !== head || current.base !== base || current.repo.id !== repo.id) return false
  const changesNew = (s.changes?.generatedAt ?? null) !== (analysis.changes?.generatedAt ?? null)
  const reviewNew = (s.review?.generatedAt ?? null) !== (analysis.review?.generatedAt ?? null)
  // The repo's notes only feed the tooltips: taken in quietly (the map reads them when a tooltip opens).
  const notesNew = !!s.notes && JSON.stringify(s.notes) !== JSON.stringify(analysis.notes ?? null)
  if (notesNew) analysis.notes = s.notes
  if (!changesNew && !reviewNew) {
    if (notesNew) flashNote('File and folder notes updated')
    return notesNew
  }
  analysis.changes = s.changes ?? undefined
  analysis.review = s.review ?? undefined
  if (changesNew) map.setChanges(analysis.changes)
  const panel = $('#panel-body')
  const scroll = panel.scrollTop
  renderPanel()
  panel.scrollTop = scroll
  flashNote(reviewNew && changesNew ? 'AI review and change descriptions updated' : reviewNew ? 'AI review updated' : 'Change descriptions updated')
  return true
}

/** A passing note at the top of the panel (what just changed by itself). */
function flashNote(text: string) {
  const note = document.querySelector<HTMLElement>('#newer')
  if (!note) return
  note.textContent = text
  note.hidden = false
  setTimeout(() => {
    if (note.isConnected && note.textContent === text) note.hidden = true
  }, 4000)
}

let refreshing = false

/**
 * Keeps the view live: when the branch (or its base) has moved to another commit, the map is made again for it, without
 * asking; otherwise any review saved meanwhile is shown. Runs every few seconds while the page is shown, and when the
 * window comes forward.
 */
async function stayLive() {
  if (!current || !analysis || refreshing) return
  refreshing = true
  try {
    const { repo, head, base } = current
    const seq = routing
    let at: { head: string | null; base: string | null }
    try {
      at = await api(`/api/commits?${new URLSearchParams({ repo: repo.id, head, base })}`)
    } catch {
      return
    }
    if (seq !== routing) return // another branch was opened meanwhile
    // A branch deleted under us stays as it was: there's nothing newer to show.
    if (at.head && at.base && (at.head !== analysis.headSha || at.base !== analysis.baseSha)) {
      let a: Analysis
      try {
        a = await api<Analysis>(`/api/analysis?${new URLSearchParams({ repo: repo.id, head, base })}`)
      } catch {
        return
      }
      if (seq !== routing) return
      const moved = a.headSha !== analysis.headSha
      analysis = a
      const panel = $('#panel-body')
      const scroll = panel.scrollTop
      map.load(analysis)
      syncScope()
      void fillWholeRepoText()
      renderPanel()
      panel.scrollTop = scroll
      flashNote(!moved ? `Updated: ${base} moved to ${a.baseSha.slice(0, 7)}` : a.uncommitted ? `Updated: ${head}’s uncommitted changes` : `Updated to ${head}’s new commit ${a.headSha.slice(0, 7)}`)
      void loadBranches(repo).then(renderBranchPicker, () => {})
      return
    }
    await showNewlySaved()
  } finally {
    refreshing = false
  }
}

// Uncaught errors go to the server's output too: in the desktop app there's no console to read them in.
const report = (message: string) => {
  try {
    fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
  } catch {}
}
window.addEventListener('error', (e) => report(`${e.message} at ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? '\n' + e.error.stack : ''}`))
window.addEventListener('unhandledrejection', (e) => report(`Unhandled: ${e.reason instanceof Error ? e.reason.stack ?? e.reason.message : String(e.reason)}`))

/** The map's view options (MapOptions): settings, in the Settings dialog's Map group. */
const SHOW_KEYS = ['showImpacted', 'dimUnchanged', 'showCode', 'showTests', 'showLocales', 'showDocs', 'showUnchanged', 'showTiming'] as const
const showOptions = () => Object.fromEntries(SHOW_KEYS.map((k) => [k, settings[k]])) as unknown as ZoomMap['opts']

/** Settings changed (from the dialog, the divider, an import, another window): passes them on to what uses them. */
function settingsChanged(changed: SettingKey[]) {
  const show = changed.filter((k) => (SHOW_KEYS as readonly string[]).includes(k))
  if (show.length) map.setOptions(showOptions())
  if (changed.some((k) => k === 'showUnchanged' || k === 'showCode' || k === 'showTests' || k === 'showLocales' || k === 'showDocs')) {
    syncScope()
    void fillWholeRepoText()
  }
  const rest = changed.filter((k) => !show.includes(k) && k !== 'panelWidth' && k !== 'panelTextPx' && k !== 'tipTextPx' && k !== 'showPrs' && !SHORTCUT_KEYS.includes(k))
  if (changed.some((k) => SHORTCUT_KEYS.includes(k))) syncShortcuts()
  if (rest.length) map.settingsChanged(rest, rest.some((k) => LAYOUT_KEYS.includes(k)))
  if (changed.includes('liveCheckSeconds')) startLiveChecks()
  if (changed.includes('showPrs')) {
    renderBranchPicker()
    if (current) void loadPrs(current.repo)
  }
}

/**
 * The header's map switches, each a setting one click (or key) away: Changes | Whole repo (Unchanged files), and the
 * Show list's Code, Docs, Tests and Translations (greyed out when the repo has none).
 */
const scopeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('#scope button')]
const kindInputs = () => [...document.querySelectorAll<HTMLInputElement>('#kindsPop input')]
type KindKey = 'showCode' | 'showTests' | 'showLocales' | 'showDocs'
function syncScope() {
  for (const b of scopeButtons()) b.setAttribute('aria-pressed', String((b.dataset.whole === '1') === settings.showUnchanged))
  let on = 0
  for (const input of kindInputs()) {
    const row = input.closest('label')!
    const roles = row.dataset.role!.split(' ')
    const none = !!analysis && !analysis.files.some((f) => roles.includes(roleOf(f)))
    input.checked = settings[input.dataset.key as KindKey]
    input.disabled = none
    row.classList.toggle('none', none)
    row.title = none ? `None in this repo` : ''
    if (input.checked && !none) on++
  }
  $('#kindsBtn .picker-name').textContent = `Show (${on})`
}

/** Opens or closes the Show list; it closes on Escape or a click outside it. */
function showKinds(open: boolean, refocus = false) {
  const pop = $('#kindsPop')
  const btn = $('#kindsBtn')
  if (pop.hidden === !open) return
  pop.hidden = !open
  btn.classList.toggle('open', open)
  btn.setAttribute('aria-expanded', String(open))
  if (open) kindInputs().find((i) => !i.disabled)?.focus({ preventScroll: true })
  else if (refocus) btn.focus({ preventScroll: true })
}
const setWholeRepo = (whole: boolean) => update({ showUnchanged: whole })
const toggleKind = (key: KindKey) => update({ [key]: !settings[key] })

/**
 * Whole repo shows every file's text, not just the changed ones': the analysis only carries changed files' text, so
 * the rest is read once per analysis and each unchanged file gets one run of plain lines (no + or −).
 */
let textFilled: Analysis | null = null
async function fillWholeRepoText() {
  const a = analysis
  if (!a || !current || !map.wholeRepo || textFilled === a) return
  textFilled = a
  let texts: Record<string, string>
  try {
    texts = await api<Record<string, string>>(`/api/texts?${new URLSearchParams({ repo: current.repo.id, sha: a.headSha })}`)
  } catch {
    textFilled = null
    return
  }
  if (analysis !== a) return
  let added = 0
  for (const f of a.files) {
    if (f.status !== 'unchanged' || f.hunks?.length) continue
    const t = texts[f.path]
    if (t === undefined) continue
    const lines = t.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    if (!lines.length) continue
    f.text = t
    f.hunks = [{ header: `@@ -1,${lines.length} +1,${lines.length} @@`, lines: lines.map((s) => ({ t: ' ' as const, s })) }]
    added++
  }
  if (added) map.textsChanged()
}

let liveTimer: ReturnType<typeof setInterval> | undefined
/** Looks for new commits and newly saved reviews every Check for new commits seconds while the page is shown. */
function startLiveChecks() {
  clearInterval(liveTimer)
  liveTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void stayLive()
  }, settings.liveCheckSeconds * 1000)
}

async function main() {
  await loadSettings()
  setupSplitter()
  map = new ZoomMap($('#map'), {
    onView: (level, trail) => showView(level, trail),
    onChange: (i) => goToChange(i),
  })
  await map.init()
  map.setOptions(showOptions())
  onSettingsChange(settingsChanged)

  // The view stays live: new commits and newly saved reviews show by themselves, whether the window is in front (the
  // session running beside it) or comes back to the front.
  window.addEventListener('focus', () => {
    void stayLive()
    if (current) void loadBranches(current.repo).then(renderBranchPicker, () => {})
  })
  startLiveChecks()
  if (tauri) {
    // The window's title bar is the header: room for the window buttons, and dragging it moves the window.
    document.documentElement.classList.add('tauri')
    for (const el of [$('header'), $('header .brand')]) el.setAttribute('data-tauri-drag-region', '')
    installUpdates(tauri)
    tauri.event.listen<string>('native-menu', ({ payload }) => {
      if (payload === 'settings') openSettings()
      else if (payload === 'check-updates') void checkForUpdates()
      else if (payload === 'whats-new') openWhatsNew()
      else if (payload === 'open-repo') addRepo()
      else if (payload === 'whole-map') $('#fit').click()
      else if (payload === 'whole-repo') setWholeRepo(!settings.showUnchanged)
      else if (payload === 'show-code') toggleKind('showCode')
      else if (payload === 'show-tests') toggleKind('showTests')
      else if (payload === 'show-locales') toggleKind('showLocales')
      else if (payload === 'show-docs') toggleKind('showDocs')
      else if (payload === 'update-branch') {
        branchList = null // read the branches again too
        route()
      }
    })
  }

  try {
    repos = await api<Repo[]>('/api/repos')
  } catch (e) {
    return panelMessage(`<h2>The app's server isn't answering</h2><p class="error">${esc(e instanceof Error ? e.message : String(e))}</p>`)
  }
  window.addEventListener('hashchange', () => route())
  route()

  $('#settingsBtn').onclick = () => openSettings()
  for (const b of scopeButtons()) b.onclick = () => setWholeRepo(b.dataset.whole === '1')
  $('#kindsBtn').onclick = () => showKinds($('#kindsPop').hidden)
  for (const input of kindInputs()) input.onchange = () => update({ [input.dataset.key as KindKey]: input.checked })
  window.addEventListener('pointerdown', (e) => {
    if (!$('#kinds').contains(e.target as Node)) showKinds(false)
  }, true)
  $('#kindsPop').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      showKinds(false, true)
    }
  })
  syncScope()
  syncShortcuts()
  // ⌘, (Ctrl+, elsewhere), as in every Mac app. The desktop app's menu has it too, and gets there first.
  window.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      openSettings()
    }
  })
  $('#fit').onclick = () => {
    map.highlight = []
    map.highlightEdge = null
    map.focus = false
    map.fitWindow()
    setActive(-1)
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'Escape') {
      // Closes an opened tooltip and drops the selection; the view stays where it is (Fit resets it).
      map.hideTip()
      map.clearSelection()
      setActive(-1)
      document.querySelectorAll('.change.active').forEach((x) => x.classList.remove('active'))
    }
    const shortcut = e.defaultPrevented ? null : shortcutOf(e)
    const command = shortcut ? SHORTCUT_KEYS.find((k) => settings[k] === shortcut) : undefined
    // Arrows and the like work only while the map has the focus: elsewhere they have jobs of their own.
    if (!shortcut || !command || (isNamedKey(shortcut) && !map.focused)) return
    e.preventDefault()
    runShortcut(command)
  })
}

/** Does what a shortcut (a Keyboard setting) stands for. */
function runShortcut(command: SettingKey) {
  const step = (by: 1 | -1, section = false) => {
    if (!analysis || !map.step(by, section)) return
    setActive(-1)
    document.querySelectorAll('.change.active').forEach((x) => x.classList.remove('active'))
  }
  const finding = (by: 1 | -1) => analysis && goToFinding(Math.max(0, Math.min(allFindings().length - 1, activeFinding + by)))
  const commands: Partial<Record<SettingKey, () => void>> = {
    keyNextFile: () => step(1),
    keyPrevFile: () => step(-1),
    keyNextSection: () => step(1, true),
    keyPrevSection: () => step(-1, true),
    keyScrollDown: () => map.scrollSelected(1),
    keyScrollUp: () => map.scrollSelected(-1),
    keyNextFinding: () => finding(1),
    keyPrevFinding: () => finding(-1),
    keyWholeRepo: () => setWholeRepo(!settings.showUnchanged),
    keyCode: () => toggleKind('showCode'),
    keyDocs: () => toggleKind('showDocs'),
    keyTests: () => toggleKind('showTests'),
    keyLocales: () => toggleKind('showLocales'),
  }
  commands[command]?.()
}

/** The shortcuts shown in the header, as they're set now. */
function syncShortcuts() {
  const whole = settings.keyWholeRepo ? ` (${shortcutLabel(settings.keyWholeRepo)})` : ''
  for (const b of scopeButtons()) b.title = (b.dataset.whole === '1' ? 'Every file in the repo' : 'Only the files the branch changes') + whole
  const keys = { showCode: settings.keyCode, showDocs: settings.keyDocs, showTests: settings.keyTests, showLocales: settings.keyLocales }
  for (const input of kindInputs()) {
    const kbd = input.closest('label')!.querySelector('kbd')!
    kbd.textContent = shortcutLabel(keys[input.dataset.key as KindKey])
    kbd.hidden = !kbd.textContent
  }
}

/** What the branch is compared with: the repo's default base, or any other branch. */
let basePicker: Picker | null = null
function baseSelect() {
  basePicker = null
  if (!current || !branchList) return `<code>${esc(analysis.base)}</code>`
  const names = [...new Set([branchList.base, current.base, ...branchList.branches.map((b) => b.name).filter((n) => n !== current!.head)].filter(Boolean))]
  basePicker = picker({
    label: 'Compared with',
    groups: () => [{ items: names.map((n) => ({ value: n, label: n, detail: n === branchList?.base ? 'default' : undefined })) }],
    onPick: (n) => current && go(current.repo.id, current.head, n === branchList?.base ? undefined : n),
  })
  basePicker.el.classList.add('inline')
  basePicker.set(current.base || branchList.base)
  return `<span id="base"></span>`
}

/** "3 commits", "3 commits and uncommitted changes", "uncommitted changes" (the snapshot isn't a commit of the branch's). */
function commitCount(a: Analysis): string {
  const n = a.commits.length - (a.uncommitted ? 1 : 0)
  const commits = `${n} commit${n === 1 ? '' : 's'}`
  if (!a.uncommitted) return commits
  const changes = `<span class="uncommitted" title="The files in ${esc(a.uncommitted)} as they are now, saved or not committed">uncommitted changes</span>`
  return n ? `${commits} and ${changes}` : changes
}

function renderPanel() {
  const a = analysis
  const changed = a.files.filter((f) => f.status !== 'unchanged')
  const source = changed.filter((f) => roleOf(f) === 'source')
  const muted = changed.filter((f) => roleOf(f) !== 'source')
  const add = source.reduce((s, f) => s + f.add, 0)
  const del = source.reduce((s, f) => s + f.del, 0)
  const count = (sev: string) => a.findings.filter((f) => f.severity === sev).length
  const commits = a.commits.map((c) => `<li><code>${esc(c.sha)}</code> ${esc(c.subject)}</li>`).join('')
  const rules = a.model.rules.map((r) => `<li>${esc(r)}</li>`).join('')
  $('#panel-body').innerHTML = `
    <section class="pr">
      <h1>${esc(a.title)}</h1>
      <div id="newer" class="newer" hidden></div>
      <div class="sub"><b>${esc(a.repo)}</b> · ${esc(a.head)} compared with ${baseSelect()} · ${commitCount(a)}</div>
      <div class="stats"><span>${source.length} source files</span><span class="plus">+${add}</span><span class="minus">−${del}</span>${muted.length ? `<span title="Tests, translations, docs and generated files: on the map but muted">${muted.length} tests, translations, docs</span>` : ''}${a.otherChanges.length ? `<span>${a.otherChanges.length} other files</span>` : ''}</div>
      ${changed.length || a.otherChanges.length ? '' : `<p class="hint">No changes against ${esc(a.base)}: the map shows the whole repo.</p>`}
      <details><summary>Commits</summary><ul class="commits">${commits}</ul></details>
    </section>
    ${reviewHtml()}
    <section>
      <h2>Architecture <span class="chips">${chip('violation', count('violation'))}${chip('warning', count('warning'))}${chip('info', count('info'))}</span></h2>
      <div class="model ${a.model.kind}">Checked against ${esc(a.model.name)} <span class="tag">${a.model.kind}</span></div>
      <div class="src">${esc(a.model.source)}</div>
      ${rules ? `<details><summary>Rules</summary><ul class="rules">${rules}</ul></details>` : ''}
      <ol class="findings">${a.findings.map((f, i) => findingHtml(f, reviewCount() + i)).join('') || '<li class="none">Nothing stands out. The change stays inside the lines the model draws.</li>'}</ol>
      <div class="hint">j / k step through findings · ← / → step through files, ↑ / ↓ through sections · double-click a box to read it · Esc clears the selection</div>
    </section>
    ${changesHtml()}
    ${a.otherChanges.length ? `<section><details><summary>Changed files not on the map (${a.otherChanges.length})</summary><ul class="other">${a.otherChanges.map((o) => `<li><span class="st ${o.status}">${o.status}</span> ${esc(o.path)} <span class="plus">+${o.add}</span> <span class="minus">−${o.del}</span></li>`).join('')}</ul></details></section>` : ''}
  `
  document.querySelectorAll<HTMLElement>('.finding').forEach((el) => {
    el.onclick = () => goToFinding(Number(el.dataset.i))
  })
  document.querySelectorAll<HTMLElement>('.change').forEach((el) => {
    const i = Number(el.dataset.i)
    el.onclick = () => goToChange(i)
    el.onmouseenter = () => map.mark(map.nodesFor(changeFiles(i)))
    el.onmouseleave = () => map.mark([])
  })
  if (basePicker) document.querySelector('#base')?.replaceWith(basePicker.el)
  activeFinding = -1
}

/** The files a change covers; -1 is the "not described" group. */
function changeFiles(i: number): string[] {
  const cs = analysis.changes!
  if (i >= 0) return cs.items[i].files
  return [...new Set(cs.undescribed.map((h) => h.slice(0, h.lastIndexOf('#'))))]
}

function changesHtml() {
  const cs = analysis.changes
  if (!cs)
    return `<section><h2>What changed</h2><p class="none">No AI descriptions for this branch. In a Claude Code session in this repo, run <code>/flyover-review</code>; they appear here when you come back.</p></section>`
  const items = cs.items
    .map(
      (c, i) => `<li class="change" data-i="${i}"><div class="ct"><span class="n">${i + 1}</span>${esc(c.title)}</div><div class="cs">${esc(c.summary)}</div><div class="cf">${c.files.length} file${c.files.length === 1 ? '' : 's'} · ${c.hunks.length} hunk${c.hunks.length === 1 ? '' : 's'}</div></li>`,
    )
    .join('')
  const gap = cs.undescribed.length
    ? `<li class="change gap" data-i="-1"><div class="ct"><span class="n">!</span>Not described: ${cs.undescribed.length} hunk${cs.undescribed.length === 1 ? '' : 's'}</div><div class="cs">No description covers these. Read them yourself.</div><ul class="ev">${cs.undescribed.slice(0, 12).map((h) => `<li><code>${esc(h)}</code></li>`).join('')}</ul></li>`
    : ''
  const stale = cs.headSha !== analysis.headSha ? `<p class="none">These describe an older commit of the branch. Run <code>/flyover-review</code> again for the new one.</p>` : ''
  const invalid = cs.invalid.length ? `<div class="hint">${cs.invalid.length} hunk id${cs.invalid.length === 1 ? '' : 's'} the model cited didn't exist and were dropped.</div>` : ''
  return `<section>
      <h2>What changed <span class="tag ai" title="Written by ${esc(cs.by)} from the diff. Every source hunk is either in a change or listed as not described.">AI-written</span></h2>
      ${stale}
      <ol class="changes-list">${items}${gap}</ol>
      ${invalid}
    </section>`
}

function goToChange(i: number) {
  if (!analysis.changes) return
  setActive(-1)
  document.querySelectorAll('.change').forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.i) === i))
  document.querySelector('.change.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  // Zoom to its files and show the arrows between them.
  const nodes = map.nodesFor(changeFiles(i))
  if (nodes.length) map.zoomTo(nodes, undefined, true)
}

function chip(sev: string, n: number, ai = false) {
  const plural = n === 1 ? '' : 's'
  const word = sev === 'violation' ? (ai ? 'bug' : 'violation') + plural : sev === 'warning' ? 'to check' : 'note' + plural
  return n ? `<span class="chip ${sev}">${n} ${word}</span>` : ''
}

/** The AI review's findings come first in the panel (and for j / k), then the analyzer's. */
const reviewCount = () => analysis.review?.findings.length ?? 0
const allFindings = (): Finding[] => [...(analysis.review?.findings ?? []), ...analysis.findings]

/** An outside AI's review (`flyover import`, the /flyover-review skill), kept apart from the analyzer's findings. */
function reviewHtml() {
  const r = analysis.review
  if (!r) return `<section><h2>AI review</h2><p class="none">None yet. In a Claude Code session in this repo, run <code>/flyover-review</code>; it appears here when you come back.</p></section>`
  const count = (sev: string) => r.findings.filter((f) => f.severity === sev).length
  const stale = r.headSha !== analysis.headSha ? `<p class="none">This reviews an older commit of the branch (${esc(r.headSha.slice(0, 7))}).</p>` : ''
  const unknown = r.unknownPaths.length ? `<p class="none">It also named paths that aren't on the map: ${r.unknownPaths.map((p) => `<code>${esc(p)}</code>`).join(', ')}</p>` : ''
  return `
    <section>
      <h2>AI review <span class="tag ai" title="Written by ${esc(r.by)} on ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))}. A judgement, not a check: it can be wrong.">AI-written</span> <span class="chips">${chip('violation', count('violation'), true)}${chip('warning', count('warning'), true)}${chip('info', count('info'), true)}</span></h2>
      ${stale}
      <ol class="findings">${r.findings.map((f, i) => findingHtml(f, i)).join('') || '<li class="none">The reviewer found nothing to report.</li>'}</ol>
      ${unknown}
    </section>`
}

function findingHtml(f: Finding, i: number) {
  const ev = f.evidence?.length ? `<ul class="ev">${f.evidence.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>` : ''
  return `<li class="finding ${f.severity}${f.by ? ' ai' : ''}" data-i="${i}"><div class="ft">${esc(f.title)}</div>${f.detail ? `<div class="fd">${esc(f.detail)}</div>` : ''}${ev}</li>`
}

function setActive(i: number) {
  activeFinding = i
  document.querySelectorAll('.finding').forEach((el, j) => el.classList.toggle('active', j === i))
  document.querySelector('.finding.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function goToFinding(i: number) {
  const f = allFindings()[i]
  if (!f) return
  setActive(i)
  const targets: MapNode[] = []
  if (f.target?.edge) {
    const a = map.nodeFor(f.target.edge.from)
    const b = map.nodeFor(f.target.edge.to)
    if (a) targets.push(a)
    if (b) targets.push(b)
  }
  for (const p of f.target?.paths ?? []) {
    const n = map.nodeFor(p)
    if (n && !targets.includes(n)) targets.push(n)
  }
  if (targets.length) map.zoomTo(targets, f.target?.edge, f.target?.focus)
}

function showView(_level: Level, trail: MapNode[]) {
  const crumbs = $('#crumbs')
  crumbs.innerHTML = trail.map((n, i) => `<a data-i="${i}">${esc(n.kind === 'root' ? n.name : n.name)}</a>`).join('<i>/</i>')
  crumbs.querySelectorAll<HTMLElement>('a').forEach((el) => {
    el.onclick = () => {
      const n = trail[Number(el.dataset.i)]
      if (n.kind === 'root') map.fitAll()
      else map.zoomTo([n])
    }
  })
}

main()
