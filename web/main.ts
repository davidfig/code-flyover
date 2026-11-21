import './style.css'
import type { Analysis, AnalysisIndexEntry, Finding } from '../shared/types.ts'
import { esc, ZoomMap, type Level } from './map.ts'
import { renderDiffView } from './diffView.ts'
import { roleOf, type MapNode } from './layout.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T


let analysis: Analysis
let map: ZoomMap
let activeFinding = -1

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
  pop.addEventListener('focusout', (e) => {
    if (!pop.contains(e.relatedTarget as Node | null) && e.relatedTarget !== btn) set(false)
  })
}

/** How many view options differ from the defaults, shown on the Show button. */
function updateShowCount() {
  const changed = Object.keys(DEFAULTS).filter((k) => map.opts[k as keyof typeof DEFAULTS] !== DEFAULTS[k as keyof typeof DEFAULTS]).length
  $('#showCount').textContent = changed ? String(changed) : ''
  $('#showBtn').title = changed ? `${changed} option${changed === 1 ? '' : 's'} changed from the default` : 'What the map shows'
}
let DEFAULTS: ZoomMap['opts']

async function main() {
  setupSplitter()
  setupShowMenu()
  const index: AnalysisIndexEntry[] = await fetch('data/index.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : []))
  const picker = $<HTMLSelectElement>('#picker')
  if (index.length === 0) {
    $('#panel-body').innerHTML = '<p class="empty">No analyses yet. Run <code>npm run analyze -- ../repo branch</code>.</p>'
    return
  }
  picker.innerHTML = index
    .map((e) => `<option value="${esc(e.id)}">${esc(e.repo)} · ${esc(e.head)} (${e.files} files)</option>`)
    .join('')
  picker.onchange = () => {
    location.hash = picker.value
  }

  map = new ZoomMap($('#map'), {
    onSelect: (n) => showSelection(n),
    onView: (level, trail) => showView(level, trail),
    onChange: (i) => goToChange(i),
  })
  await map.init()


  const open = async () => {
    const id = decodeURIComponent(location.hash.slice(1)) || index[0].id
    picker.value = id
    analysis = await fetch(`data/${id}.json`, { cache: 'no-store' }).then((r) => r.json())
    map.load(analysis)
    renderPanel()
  }
  window.addEventListener('hashchange', open)
  await open()

  DEFAULTS = { ...map.opts }
  for (const id of ['showAllImports', 'showImpacted', 'dimUnchanged', 'showTests', 'showLocales', 'showUnchanged'] as const) {
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
    if (e.key === 'j' || e.key === 'k') {
      const next = Math.max(0, Math.min(analysis.findings.length - 1, activeFinding + (e.key === 'j' ? 1 : -1)))
      goToFinding(next)
    }
  })
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
      <div class="sub"><b>${esc(a.repo)}</b> · ${esc(a.head)} → ${esc(a.base)} · ${a.commits.length} commit${a.commits.length === 1 ? '' : 's'}</div>
      <div class="stats"><span>${source.length} source files</span><span class="plus">+${add}</span><span class="minus">−${del}</span>${muted.length ? `<span title="Tests, translations and generated files: on the map but muted">${muted.length} tests/translations</span>` : ''}${a.otherChanges.length ? `<span>${a.otherChanges.length} other files</span>` : ''}</div>
      <details><summary>Commits</summary><ul class="commits">${commits}</ul></details>
    </section>
    <section>
      <h2>Architecture <span class="chips">${chip('violation', count('violation'))}${chip('warning', count('warning'))}${chip('info', count('info'))}</span></h2>
      <div class="model ${a.model.kind}">Checked against ${esc(a.model.name)} <span class="tag">${a.model.kind}</span></div>
      <div class="src">${esc(a.model.source)}</div>
      ${rules ? `<details><summary>Rules</summary><ul class="rules">${rules}</ul></details>` : ''}
      <ol class="findings">${a.findings.map((f, i) => findingHtml(f, i)).join('') || '<li class="none">Nothing stands out. The change stays inside the lines the model draws.</li>'}</ol>
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
  if (!cs) return `<section><h2>What changed</h2><p class="none">No descriptions yet. Run the analyzer without <code>--no-describe</code>.</p></section>`
  const items = cs.items
    .map(
      (c, i) => `<li class="change" data-i="${i}"><div class="ct"><span class="n">${i + 1}</span>${esc(c.title)}</div><div class="cs">${esc(c.summary)}</div><div class="cf">${c.files.length} file${c.files.length === 1 ? '' : 's'} · ${c.hunks.length} hunk${c.hunks.length === 1 ? '' : 's'}</div></li>`,
    )
    .join('')
  const gap = cs.undescribed.length
    ? `<li class="change gap" data-i="-1"><div class="ct"><span class="n">!</span>Not described: ${cs.undescribed.length} hunk${cs.undescribed.length === 1 ? '' : 's'}</div><div class="cs">No description covers these. Read them yourself.</div><ul class="ev">${cs.undescribed.slice(0, 12).map((h) => `<li><code>${esc(h)}</code></li>`).join('')}</ul></li>`
    : ''
  const invalid = cs.invalid.length ? `<div class="hint">${cs.invalid.length} hunk id${cs.invalid.length === 1 ? '' : 's'} the model cited didn't exist and were dropped.</div>` : ''
  return `<section>
      <h2>What changed <span class="tag ai" title="Written by ${esc(cs.by)} from the diff. Every source hunk is either in a change or listed as not described.">AI-written</span></h2>
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

function chip(sev: string, n: number) {
  return n ? `<span class="chip ${sev}">${n} ${sev === 'violation' ? 'violation' + (n === 1 ? '' : 's') : sev === 'warning' ? 'to check' : 'notes'}</span>` : ''
}

function findingHtml(f: Finding, i: number) {
  const ev = f.evidence?.length ? `<ul class="ev">${f.evidence.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul>` : ''
  return `<li class="finding ${f.severity}" data-i="${i}"><div class="ft">${esc(f.title)}</div>${f.detail ? `<div class="fd">${esc(f.detail)}</div>` : ''}${ev}</li>`
}

function setActive(i: number) {
  activeFinding = i
  document.querySelectorAll('.finding').forEach((el, j) => el.classList.toggle('active', j === i))
  document.querySelector('.finding.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function goToFinding(i: number) {
  const f = analysis.findings[i]
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
  const edgesOut = a.edges.filter((e) => inside.has(e.from) && !inside.has(e.to) && e.state !== 'both')
  const edgesIn = a.edges.filter((e) => inside.has(e.to) && !inside.has(e.from) && e.state !== 'both')
  const edgeList = (list: typeof edgesOut, dir: 'out' | 'in') =>
    list
      .slice(0, 30)
      .map((e) => {
        const other = a.files[dir === 'out' ? e.to : e.from]
        return `<li class="${e.state}"><span class="st ${e.state}">${e.state === 'added' ? 'new' : 'removed'}</span> ${dir === 'out' ? '→' : '←'} ${esc(other.path)}${e.line ? `<code>${esc(e.line)}</code>` : ''}</li>`
      })
      .join('')
  const info = n.kind === 'file' ? a.files[n.file!] : null
  const mod = a.model.modules.find((m) => m.id === n.module)
  const partOf = info && a.changes ? a.changes.items.flatMap((c, i) => (c.files.includes(info.path) ? [`<a class="partof" data-i="${i}">${i + 1}. ${esc(c.title)}</a>`] : [])) : []
  el.innerHTML = `
    <h2>Selected</h2>
    <div class="selname">${esc(n.path || n.name)}</div>
    <div class="sub">${n.kind}${mod?.description ? ` · ${esc(mod.description)}` : ''}</div>
    ${partOf.length ? `<div class="partofs">Part of ${partOf.join(', ')}</div>` : ''}
    ${info ? `<div class="stats"><span class="st ${info.status}">${info.status}</span>${info.oldPath ? `<span>from ${esc(info.oldPath)}</span>` : ''}<span>${info.lines} lines</span><span class="plus">+${info.add}</span><span class="minus">−${info.del}</span></div>` : `<div class="stats"><span>${n.changed} changed files</span><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></div>`}
    ${edgesOut.length ? `<h3>Imports changed (${edgesOut.length})</h3><ul class="edges">${edgeList(edgesOut, 'out')}</ul>` : ''}
    ${edgesIn.length ? `<h3>Importers changed (${edgesIn.length})</h3><ul class="edges">${edgeList(edgesIn, 'in')}</ul>` : ''}
    ${info?.hunks ? `<h3>Diff</h3><div class="diff panel-diff"></div>` : ''}
  `
  el.querySelectorAll<HTMLElement>('.partof').forEach((x) => (x.onclick = () => goToChange(Number(x.dataset.i))))
  const panelDiff = el.querySelector<HTMLElement>('.panel-diff')
  if (panelDiff && info) renderDiffView(panelDiff, info)
  el.scrollIntoView({ block: 'nearest' })
}

main()
