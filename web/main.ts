import './style.css'
import type { Analysis, AnalysisIndexEntry, Finding } from '../shared/types.ts'
import { esc, renderDiff, ZoomMap, type Level } from './map.ts'
import type { MapNode } from './layout.ts'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

const LEVELS: Level[] = ['System', 'Module', 'Folder', 'File', 'Diff']

let analysis: Analysis
let map: ZoomMap
let activeFinding = -1

async function main() {
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

  for (const id of ['showAllImports', 'showImpacted', 'dimUnchanged'] as const) {
    const box = $<HTMLInputElement>('#' + id)
    box.checked = map.opts[id]
    box.onchange = () => map.setOptions({ [id]: box.checked })
  }
  $('#fit').onclick = () => {
    map.highlight = []
    map.highlightEdge = null
    map.focus = false
    map.fitAll()
    setActive(-1)
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    if (e.key === 'Escape') { map.select(null); map.fitAll() }
    if (e.key === 'j' || e.key === 'k') {
      const next = Math.max(0, Math.min(analysis.findings.length - 1, activeFinding + (e.key === 'j' ? 1 : -1)))
      goToFinding(next)
    }
  })
}

function renderPanel() {
  const a = analysis
  const changed = a.files.filter((f) => f.status !== 'unchanged')
  const add = changed.reduce((s, f) => s + f.add, 0)
  const del = changed.reduce((s, f) => s + f.del, 0)
  const count = (sev: string) => a.findings.filter((f) => f.severity === sev).length
  const commits = a.commits.map((c) => `<li><code>${esc(c.sha)}</code> ${esc(c.subject)}</li>`).join('')
  const rules = a.model.rules.map((r) => `<li>${esc(r)}</li>`).join('')
  $('#panel-body').innerHTML = `
    <section class="pr">
      <h1>${esc(a.title)}</h1>
      <div class="sub"><b>${esc(a.repo)}</b> · ${esc(a.head)} → ${esc(a.base)} · ${a.commits.length} commit${a.commits.length === 1 ? '' : 's'}</div>
      <div class="stats"><span>${changed.length} code files</span><span class="plus">+${add}</span><span class="minus">−${del}</span>${a.otherChanges.length ? `<span>${a.otherChanges.length} other files</span>` : ''}</div>
      <details><summary>Commits</summary><ul class="commits">${commits}</ul></details>
    </section>
    <section>
      <h2>Architecture model</h2>
      <div class="model ${a.model.kind}">${esc(a.model.name)} <span class="tag">${a.model.kind}</span></div>
      <div class="src">${esc(a.model.source)}</div>
      ${rules ? `<details><summary>Rules</summary><ul class="rules">${rules}</ul></details>` : ''}
    </section>
    <section>
      <h2>Where to look <span class="chips">${chip('violation', count('violation'))}${chip('warning', count('warning'))}${chip('info', count('info'))}</span></h2>
      <ol class="findings">${a.findings.map((f, i) => findingHtml(f, i)).join('') || '<li class="none">Nothing stands out. The change stays inside the lines the model draws.</li>'}</ol>
      <div class="hint">j / k step through findings · double-click to zoom · Esc for the whole map</div>
    </section>
    <section id="selection"></section>
    ${a.otherChanges.length ? `<section><details><summary>Changed files not on the map (${a.otherChanges.length})</summary><ul class="other">${a.otherChanges.map((o) => `<li><span class="st ${o.status}">${o.status}</span> ${esc(o.path)} <span class="plus">+${o.add}</span> <span class="minus">−${o.del}</span></li>`).join('')}</ul></details></section>` : ''}
  `
  document.querySelectorAll<HTMLElement>('.finding').forEach((el) => {
    el.onclick = () => goToFinding(Number(el.dataset.i))
  })
  activeFinding = -1
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

function showView(level: Level, trail: MapNode[]) {
  $('#levels').innerHTML = LEVELS.map((l) => `<span class="${l === level ? 'on' : ''}">${l}</span>`).join('<i>›</i>')
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
  el.innerHTML = `
    <h2>Selected</h2>
    <div class="selname">${esc(n.path || n.name)}</div>
    <div class="sub">${n.kind}${mod?.description ? ` · ${esc(mod.description)}` : ''}</div>
    ${info ? `<div class="stats"><span class="st ${info.status}">${info.status}</span>${info.oldPath ? `<span>from ${esc(info.oldPath)}</span>` : ''}<span>${info.lines} lines</span><span class="plus">+${info.add}</span><span class="minus">−${info.del}</span></div>` : `<div class="stats"><span>${n.changed} changed files</span><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></div>`}
    ${edgesOut.length ? `<h3>Imports changed (${edgesOut.length})</h3><ul class="edges">${edgeList(edgesOut, 'out')}</ul>` : ''}
    ${edgesIn.length ? `<h3>Importers changed (${edgesIn.length})</h3><ul class="edges">${edgeList(edgesIn, 'in')}</ul>` : ''}
    ${info?.hunks ? `<h3>Diff</h3><div class="diff panel-diff">${renderDiff(info)}</div>` : ''}
  `
  el.scrollIntoView({ block: 'nearest' })
}

main()
