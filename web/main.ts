import type { Analysis, ChangeSet, Finding, Review } from '../shared/types.ts'
import { esc, ZoomMap, type Level } from './map.ts'
import { renderDiffView } from './diffView.ts'
import { roleOf, type MapNode } from './layout.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T


let analysis: Analysis
let map: ZoomMap
let activeFinding = -1
/** How often the page looks for new commits and newly saved reviews while it's shown. */
const LIVE_CHECK_MS = 4000

const PANEL_KEY = 'semantic-zoom:panelWidth'
const PANEL_DEFAULT = 400
const PANEL_MIN = 260

/** The side panel's width: dragged with the divider (or arrow keys), remembered in localStorage. */
function setupSplitter() {
  const panel = $('#panel')
  const splitter = $('#splitter')
  const clamp = (w: number) => Math.round(Math.max(PANEL_MIN, Math.min(w, window.innerWidth * 0.7)))
  const apply = (w: number, save: boolean) => {
    const width = clamp(w)
    panel.style.width = width + 'px'
    splitter.setAttribute('aria-valuenow', String(width))
    if (save) {
      try { localStorage.setItem(PANEL_KEY, String(width)) } catch {}
    }
  }
  let saved: number | null = null
  try { saved = Number(localStorage.getItem(PANEL_KEY)) || null } catch {}
  apply(saved ?? PANEL_DEFAULT, false)
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
  splitter.addEventListener('dblclick', () => apply(PANEL_DEFAULT, true))
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20
    if (e.key === 'ArrowLeft') apply(panel.offsetWidth + step, true)
    else if (e.key === 'ArrowRight') apply(panel.offsetWidth - step, true)
    else return
    e.preventDefault()
  })
  // Keep it within bounds when the window shrinks.
  window.addEventListener('resize', () => apply(panel.offsetWidth, false))
}

/** The Show menu: opens on its button, closes on a click outside, Esc, or Tab out; the button counts what's on. */
function setupShowMenu() {
  const btn = $<HTMLButtonElement>('#showBtn')
  const pop = $('#showMenu')
  const set = (open: boolean) => {
    pop.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) pop.querySelector<HTMLInputElement>('input')?.focus()
  }
  btn.onclick = (e) => {
    e.stopPropagation()
    set(pop.hidden)
  }
  document.addEventListener('pointerdown', (e) => {
    const t = e.target
    if (!pop.hidden && !(t instanceof Element && t.closest('.menu'))) set(false)
  })
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      set(false)
      btn.focus()
    }
  })
  // Tabbing out of the menu closes it. Only when focus lands on something else: Safari and the desktop app (WebKit)
  // don't focus a checkbox you click, so a click inside moves focus to nothing (relatedTarget null). Clicks outside
  // are the pointerdown handler's job.
  pop.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null
    if (to && !pop.contains(to) && to !== btn) set(false)
  })
}

/** How many view options differ from the defaults, shown on the Show button. */
function updateShowCount() {
  const changed = Object.keys(DEFAULTS).filter((k) => map.opts[k as keyof typeof DEFAULTS] !== DEFAULTS[k as keyof typeof DEFAULTS]).length
  $('#showCount').textContent = changed ? String(changed) : ''
  $('#showBtn').title = changed ? `${changed} option${changed === 1 ? '' : 's'} changed from the default` : 'What the map shows'
}
let DEFAULTS: ZoomMap['opts']

// ---------- the desktop app (src-tauri) ----------

/** What the desktop app's window offers the page (Tauri's global API); undefined in a browser tab. */
interface TauriGlobal {
  dialog: { open(options: { directory: boolean; title?: string; defaultPath?: string }): Promise<string | null> }
  event: { listen(name: string, handler: (e: { payload: string }) => void): Promise<() => void> }
}
const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__

// ---------- repos and branches (server/api.ts) ----------

interface Repo { id: string; name: string; path: string }
interface Branch { name: string; sha: string; date: string; subject: string; ahead: number; behind: number; worktree?: string }

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

function renderRepoPicker() {
  const sel = $<HTMLSelectElement>('#repo')
  const open = current?.repo
  sel.innerHTML =
    repos.map((r) => `<option value="${esc(r.id)}" title="${esc(r.path)}">${esc(r.name)}</option>`).join('') +
    `<optgroup label="──────────"><option value=":add">Add a repo…</option>${open ? `<option value=":remove">Remove ${esc(open.name)} from the list</option>` : ''}</optgroup>`
  sel.value = open?.id ?? ''
}

function renderBranchPicker() {
  const sel = $<HTMLSelectElement>('#branch')
  if (!current || !branchList || branchList.repo !== current.repo.id) {
    sel.innerHTML = ''
    sel.disabled = true
    return
  }
  sel.disabled = false
  const list = branchList.branches
  const known = list.some((b) => b.name === current!.head)
  sel.innerHTML =
    (known ? '' : `<option value="${esc(current.head)}">${esc(current.head)}</option>`) +
    list
      .map((b) => {
        const where = b.worktree ? ' · checked out' : ''
        return `<option value="${esc(b.name)}" title="${esc(b.subject)}${b.worktree ? `\n${esc(b.worktree)}` : ''}">${esc(b.name)} · ${b.ahead} ahead · ${ago(b.date)}${where}</option>`
      })
      .join('')
  sel.value = current.head
}

async function loadBranches(repo: Repo) {
  const r = await api<{ base: string; branches: Branch[] }>(`/api/branches?repo=${encodeURIComponent(repo.id)}`)
  branchList = { repo: repo.id, ...r }
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
    return panelMessage(`<h2>No repos yet</h2><p>Run <code>semantic-zoom</code> in a repo, or add one here.</p>${addRepoButton}`)
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
      return panelMessage(`<h2>Nothing to review in ${esc(repo.name)}</h2><p>It has no local branches besides <code>${esc(branchList!.base)}</code>.</p>`)
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
  renderPanel()
}

/**
 * A review or descriptions saved since the panel was drawn (`semantic-zoom import`, from a Claude Code session): shown
 * at once, without making the map again: your zoom and selection stay. Returns whether anything changed.
 */
async function showNewlySaved(): Promise<boolean> {
  if (!current || !analysis) return false
  const { repo, head, base } = current
  let s: { changes: ChangeSet | null; review: Review | null }
  try {
    s = await api(`/api/saved?${new URLSearchParams({ repo: repo.id, head, base })}`)
  } catch {
    return false
  }
  if (current?.head !== head || current.base !== base || current.repo.id !== repo.id) return false
  const changesNew = (s.changes?.generatedAt ?? null) !== (analysis.changes?.generatedAt ?? null)
  const reviewNew = (s.review?.generatedAt ?? null) !== (analysis.review?.generatedAt ?? null)
  if (!changesNew && !reviewNew) return false
  analysis.changes = s.changes ?? undefined
  analysis.review = s.review ?? undefined
  if (changesNew) map.setChanges(analysis.changes)
  const panel = $('#panel-body')
  const scroll = panel.scrollTop
  renderPanel()
  panel.scrollTop = scroll
  if (map.selected) showSelection(map.selected)
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
      renderPanel()
      panel.scrollTop = scroll
      flashNote(moved ? `Updated to ${head}’s new commit ${a.headSha.slice(0, 7)}` : `Updated: ${base} moved to ${a.baseSha.slice(0, 7)}`)
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

async function main() {
  setupSplitter()
  setupShowMenu()
  map = new ZoomMap($('#map'), {
    onSelect: (n) => showSelection(n),
    onView: (level, trail) => showView(level, trail),
    onChange: (i) => goToChange(i),
  })
  await map.init()

  const repoSel = $<HTMLSelectElement>('#repo')
  repoSel.onchange = () => {
    if (repoSel.value === ':add') return addRepo()
    if (repoSel.value === ':remove') return current && removeRepo(current.repo)
    go(repoSel.value)
  }
  const branchSel = $<HTMLSelectElement>('#branch')
  branchSel.onchange = () => current && go(current.repo.id, branchSel.value)
  // The view stays live: new commits and newly saved reviews show by themselves, whether the window is in front (the
  // session running beside it) or comes back to the front.
  window.addEventListener('focus', () => {
    void stayLive()
    if (current) void loadBranches(current.repo).then(renderBranchPicker, () => {})
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void stayLive()
  }, LIVE_CHECK_MS)
  if (tauri) {
    // The window's title bar is the header: room for the window buttons, and dragging it moves the window.
    document.documentElement.classList.add('tauri')
    for (const el of [$('header'), $('header .brand')]) el.setAttribute('data-tauri-drag-region', '')
    tauri.event.listen('native-menu', ({ payload }) => {
      if (payload === 'open-repo') addRepo()
      else if (payload === 'whole-map') $('#fit').click()
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

  DEFAULTS = { ...map.opts }
  for (const id of ['showImpacted', 'dimUnchanged', 'showTests', 'showLocales', 'showUnchanged', 'showTiming'] as const) {
    const box = $<HTMLInputElement>('#' + id)
    let saved: string | null = null
    try { saved = localStorage.getItem('semantic-zoom:' + id) } catch {}
    if (saved !== null && saved !== String(map.opts[id])) map.setOptions({ [id]: saved === 'true' })
    box.checked = map.opts[id]
    box.onchange = () => {
      try { localStorage.setItem('semantic-zoom:' + id, String(box.checked)) } catch {}
      map.setOptions({ [id]: box.checked })
      updateShowCount()
    }
  }
  updateShowCount()
  $('#fit').onclick = () => {
    map.highlight = []
    map.highlightEdge = null
    map.focus = false
    map.fitAll()
    setActive(-1)
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    if (e.key === 'Escape') {
      // Drops the selection; the view stays where it is (Whole map resets it).
      map.clearSelection()
      setActive(-1)
      document.querySelectorAll('.change.active').forEach((x) => x.classList.remove('active'))
    }
    if ((e.key === 'j' || e.key === 'k') && analysis) {
      const next = Math.max(0, Math.min(allFindings().length - 1, activeFinding + (e.key === 'j' ? 1 : -1)))
      goToFinding(next)
    }
  })
}

/** What the branch is compared with: the repo's default base, or any other branch. */
function baseSelect() {
  if (!current || !branchList) return `<code>${esc(analysis.base)}</code>`
  const names = [...new Set([branchList.base, current.base, ...branchList.branches.map((b) => b.name).filter((n) => n !== current!.head)])]
  return `<select id="base" aria-label="Compared with">${names.map((n) => `<option value="${esc(n)}"${n === current!.base ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`
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
      <div class="sub"><b>${esc(a.repo)}</b> · ${esc(a.head)} compared with ${baseSelect()} · ${a.commits.length} commit${a.commits.length === 1 ? '' : 's'}</div>
      <div class="stats"><span>${source.length} source files</span><span class="plus">+${add}</span><span class="minus">−${del}</span>${muted.length ? `<span title="Tests, translations and generated files: on the map but muted">${muted.length} tests/translations</span>` : ''}${a.otherChanges.length ? `<span>${a.otherChanges.length} other files</span>` : ''}</div>
      <details><summary>Commits</summary><ul class="commits">${commits}</ul></details>
    </section>
    ${reviewHtml()}
    <section>
      <h2>Architecture <span class="chips">${chip('violation', count('violation'))}${chip('warning', count('warning'))}${chip('info', count('info'))}</span></h2>
      <div class="model ${a.model.kind}">Checked against ${esc(a.model.name)} <span class="tag">${a.model.kind}</span></div>
      <div class="src">${esc(a.model.source)}</div>
      ${rules ? `<details><summary>Rules</summary><ul class="rules">${rules}</ul></details>` : ''}
      <ol class="findings">${a.findings.map((f, i) => findingHtml(f, reviewCount() + i)).join('') || '<li class="none">Nothing stands out. The change stays inside the lines the model draws.</li>'}</ol>
      <div class="hint">j / k step through findings · double-click a box to read it · Esc clears the selection</div>
    </section>
    ${changesHtml()}
    <section id="selection"></section>
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
  const baseSel = document.querySelector<HTMLSelectElement>('#base')
  if (baseSel) baseSel.onchange = () => current && go(current.repo.id, current.head, baseSel.value === branchList?.base ? undefined : baseSel.value)
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
    return `<section><h2>What changed</h2><p class="none">No AI descriptions for this branch. In a Claude Code session in this repo, run <code>/zoom-review</code>; they appear here when you come back.</p></section>`
  const items = cs.items
    .map(
      (c, i) => `<li class="change" data-i="${i}"><div class="ct"><span class="n">${i + 1}</span>${esc(c.title)}</div><div class="cs">${esc(c.summary)}</div><div class="cf">${c.files.length} file${c.files.length === 1 ? '' : 's'} · ${c.hunks.length} hunk${c.hunks.length === 1 ? '' : 's'}</div></li>`,
    )
    .join('')
  const gap = cs.undescribed.length
    ? `<li class="change gap" data-i="-1"><div class="ct"><span class="n">!</span>Not described: ${cs.undescribed.length} hunk${cs.undescribed.length === 1 ? '' : 's'}</div><div class="cs">No description covers these. Read them yourself.</div><ul class="ev">${cs.undescribed.slice(0, 12).map((h) => `<li><code>${esc(h)}</code></li>`).join('')}</ul></li>`
    : ''
  const stale = cs.headSha !== analysis.headSha ? `<p class="none">These describe an older commit of the branch. Run <code>/zoom-review</code> again for the new one.</p>` : ''
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

/** An outside AI's review (`semantic-zoom import`, the /zoom-review skill), kept apart from the analyzer's findings. */
function reviewHtml() {
  const r = analysis.review
  if (!r) return `<section><h2>AI review</h2><p class="none">None yet. In a Claude Code session in this repo, run <code>/zoom-review</code>; it appears here when you come back.</p></section>`
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

function showSelection(n: MapNode | null) {
  const el = $('#selection')
  if (!el) return
  if (!n) {
    el.innerHTML = ''
    return
  }
  const a = analysis
  const filesIn = (m: MapNode): number[] => (m.kind === 'file' ? [m.file!] : m.children.flatMap(filesIn))
  const inside = new Set(filesIn(n))
  // A file lists all its imports and importers (the map outlines them in the same colours); a folder or module only
  // the ones this branch changed, since all of a folder's imports would be a long list of the usual.
  const all = n.kind === 'file'
  const byState = { added: 0, removed: 1, both: 2 }
  const edgesOut = a.edges.filter((e) => inside.has(e.from) && !inside.has(e.to) && (all || e.state !== 'both')).sort((x, y) => byState[x.state] - byState[y.state])
  const edgesIn = a.edges.filter((e) => inside.has(e.to) && !inside.has(e.from) && (all || e.state !== 'both')).sort((x, y) => byState[x.state] - byState[y.state])
  const edgeList = (list: typeof edgesOut, dir: 'out' | 'in') =>
    list
      .slice(0, 40)
      .map((e) => {
        const i = dir === 'out' ? e.to : e.from
        const other = a.files[i]
        const tag = e.state === 'both' ? '' : `<span class="st ${e.state}">${e.state === 'added' ? 'new' : 'removed'}</span> `
        // Clicking one flies to it, if it's on the map (a test with Tests off isn't).
        const name = map.hasFile(i) && e.state !== 'removed' ? `<a class="goto" data-file="${i}">${esc(other.path)}</a>` : `<span class="off">${esc(other.path)}</span>`
        return `<li class="${e.state}">${tag}${name}${e.line ? `<code>${esc(e.line)}</code>` : ''}</li>`
      })
      .join('') + (list.length > 40 ? `<li class="more">and ${list.length - 40} more</li>` : '')
  const heading = (label: string, sw: string, list: typeof edgesOut) => `<h3>${all ? `<i class="sw ${sw}"></i>` : ''}${label} (${list.length})</h3>`
  const info = n.kind === 'file' ? a.files[n.file!] : null
  const mod = a.model.modules.find((m) => m.id === n.module)
  const partOf = info && a.changes ? a.changes.items.flatMap((c, i) => (c.files.includes(info.path) ? [`<a class="partof" data-i="${i}">${i + 1}. ${esc(c.title)}</a>`] : [])) : []
  el.innerHTML = `
    <h2>Selected</h2>
    <div class="selname">${esc(n.path || n.name)}</div>
    <div class="sub">${n.kind}${mod?.description ? ` · ${esc(mod.description)}` : ''}</div>
    ${partOf.length ? `<div class="partofs">Part of ${partOf.join(', ')}</div>` : ''}
    ${info ? `<div class="stats"><span class="st ${info.status}">${info.status}</span>${info.oldPath ? `<span>from ${esc(info.oldPath)}</span>` : ''}<span>${info.lines} lines</span><span class="plus">+${info.add}</span><span class="minus">−${info.del}</span></div>` : `<div class="stats"><span>${n.changed} changed files</span><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></div>`}
    ${edgesOut.length ? `${heading(all ? 'Imports' : 'Imports changed', 'imports', edgesOut)}<ul class="edges">${edgeList(edgesOut, 'out')}</ul>` : ''}
    ${edgesIn.length ? `${heading(all ? 'Imported by' : 'Importers changed', 'importers', edgesIn)}<ul class="edges">${edgeList(edgesIn, 'in')}</ul>` : ''}
    ${info?.hunks ? `<h3>Diff</h3><div class="diff panel-diff"></div>` : ''}
  `
  el.querySelectorAll<HTMLElement>('.partof').forEach((x) => (x.onclick = () => goToChange(Number(x.dataset.i))))
  el.querySelectorAll<HTMLElement>('.goto').forEach((x) => (x.onclick = () => map.goToFile(Number(x.dataset.file))))
  const panelDiff = el.querySelector<HTMLElement>('.panel-diff')
  if (panelDiff && info) renderDiffView(panelDiff, info, { selfScroll: true })
  el.scrollIntoView({ block: 'nearest' })
}

main()
