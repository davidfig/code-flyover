// The zoomable map: pixi draws the rectangles and the dependency arrows;
// two DOM layers draw the text (labels stay a fixed screen size, diffs scale with the map).

import { Application, Container, Graphics } from 'pixi.js'
import { Viewport } from 'pixi-viewport'
import type { Analysis, FileEdge, FileInfo } from '../shared/types.ts'
import { buildMap, WORLD_H, WORLD_W, type MapNode } from './layout.ts'

/** A node opens (shows its children) once it is this many pixels on its short side. */
const OPEN_PX = 170
/** A file shows its diff once it is this wide on screen. */
const DIFF_PX = 300

export type Level = 'System' | 'Module' | 'Folder' | 'File' | 'Diff'

export interface MapOptions {
  showAllImports: boolean
  showImpacted: boolean
  dimUnchanged: boolean
}

export interface ModuleEdgeInfo {
  from: string
  to: string
  violation: boolean
}

export interface MapEvents {
  onSelect(node: MapNode | null): void
  onView(level: Level, trail: MapNode[]): void
}

const C = {
  bg: 0xf3f0e8,
  module: 0xe9e4d8,
  moduleBorder: 0xb9b2a2,
  dir: 0xf7f5ef,
  dirBorder: 0xd3cdbf,
  file: 0xdcd7cb,
  fileTest: 0xe6e2d8,
  modified: 0xe8a33d,
  added: 0x3f9e64,
  deleted: 0xc8414f,
  impacted: 0x9fc3e3,
  edgeAdded: 0xd9822b,
  edgeViolation: 0xc8414f,
  edgeRemoved: 0x7a6fb0,
  edgeAll: 0x8a8578,
  select: 0x1f6feb,
}

export class ZoomMap {
  app!: Application
  viewport!: Viewport
  a!: Analysis
  root!: MapNode
  nodes: MapNode[] = []
  fileNodes: MapNode[] = []
  byPath = new Map<string, MapNode>()
  ancestors: MapNode[][] = []
  impacted = new Set<number>()
  violations = new Set<string>()
  opts: MapOptions = { showAllImports: false, showImpacted: true, dimUnchanged: false }
  selected: MapNode | null = null
  highlight: MapNode[] = []
  highlightEdge: { from: string; to: string } | null = null
  focus = false

  private boxes = new Graphics()
  private filesG = new Graphics()
  private edgesG = new Graphics()
  private selectG = new Graphics()
  private labels: HTMLElement
  private diffs: HTMLElement
  private labelPool: HTMLElement[] = []
  private diffEls = new Map<number, HTMLElement>()
  private pending = false
  private lastLevel = ''
  private userMoved = false

  constructor(private host: HTMLElement, private events: MapEvents) {
    this.labels = document.createElement('div')
    this.labels.className = 'labels'
    this.diffs = document.createElement('div')
    this.diffs.className = 'diffs'
  }

  async init() {
    this.app = new Application()
    await this.app.init({ resizeTo: this.host, antialias: true, background: C.bg, autoDensity: true, resolution: window.devicePixelRatio })
    this.host.appendChild(this.app.canvas)
    this.host.appendChild(this.diffs)
    this.host.appendChild(this.labels)
    this.viewport = new Viewport({
      screenWidth: this.host.clientWidth,
      screenHeight: this.host.clientHeight,
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      events: this.app.renderer.events,
      passiveWheel: false,
    })
    this.app.stage.addChild(this.viewport)
    const layer = new Container()
    layer.addChild(this.boxes, this.filesG, this.edgesG, this.selectG)
    this.viewport.addChild(layer)
    this.viewport.drag().pinch().wheel({ smooth: 4 }).decelerate({ friction: 0.92 }).clampZoom({ minScale: 0.2, maxScale: 600 })
    this.viewport.on('moved', () => this.schedule())
    // animate() doesn't emit 'moved'; the dirty flag catches every change.
    this.app.ticker.add(() => {
      if (this.viewport.dirty) {
        this.viewport.dirty = false
        this.schedule()
      }
    })
    let last = { t: 0, n: null as MapNode | null }
    this.viewport.on('clicked', (e) => {
      const n = this.hit(e.world.x, e.world.y)
      const now = performance.now()
      const double = n && last.n === n && now - last.t < 400
      last = { t: now, n }
      this.select(n)
      if (double) this.zoomTo([n!])
    })
    for (const ev of ['drag-start', 'pinch-start', 'wheel'] as const) this.viewport.on(ev, () => (this.userMoved = true))
    new ResizeObserver(() => {
      this.viewport.resize(this.host.clientWidth, this.host.clientHeight, WORLD_W, WORLD_H)
      if (!this.userMoved && this.root) this.fitAll(false)
      this.schedule()
    }).observe(this.host)
  }

  load(a: Analysis) {
    this.a = a
    const m = buildMap(a)
    this.root = m.root
    this.nodes = m.nodes
    this.fileNodes = m.fileNodes
    this.byPath = m.byPath
    this.ancestors = []
    for (const n of this.fileNodes) {
      const chain: MapNode[] = []
      for (let c: MapNode | null = n; c; c = c.parent) chain.unshift(c)
      this.ancestors[n.file!] = chain
    }
    this.impacted = new Set(a.impacted)
    this.violations = new Set(
      a.findings.filter((f) => f.kind === 'forbidden-dependency' || f.kind === 'deepens-violation').map((f) => `${f.target!.edge!.from}>${f.target!.edge!.to}`),
    )
    this.selected = null
    this.highlight = []
    this.highlightEdge = null
    this.focus = false
    for (const el of this.diffEls.values()) el.remove()
    this.diffEls.clear()
    this.drawBoxes()
    this.userMoved = false
    this.fitAll(false)
  }

  setOptions(o: Partial<MapOptions>) {
    Object.assign(this.opts, o)
    this.drawBoxes()
    this.schedule()
  }

  fitAll(animate = true) {
    if (animate) this.userMoved = false
    this.zoomToRect(this.root.x, this.root.y, this.root.w, this.root.h, animate)
  }

  zoomTo(targets: MapNode[], edge?: { from: string; to: string }, focus = false) {
    this.focus = focus
    if (targets.length === 0) return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const n of targets) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y)
      x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h)
    }
    this.highlight = targets
    this.highlightEdge = edge ?? null
    this.zoomToRect(x0, y0, x1 - x0, y1 - y0, true)
    this.schedule()
  }

  private zoomToRect(x: number, y: number, w: number, h: number, animate: boolean) {
    const sw = this.viewport.screenWidth
    const sh = this.viewport.screenHeight
    const scale = Math.min(600, Math.min(sw / w, sh / h) * 0.86)
    const position = { x: x + w / 2, y: y + h / 2 }
    if (animate) this.viewport.animate({ position, scale, time: 650, ease: 'easeInOutSine', removeOnInterrupt: true })
    else {
      this.viewport.setZoom(scale, true)
      this.viewport.moveCenter(position.x, position.y)
    }
    this.schedule()
  }

  select(n: MapNode | null) {
    this.selected = n
    this.events.onSelect(n)
    this.schedule()
  }

  nodeFor(path: string): MapNode | undefined {
    if (this.byPath.has(path)) return this.byPath.get(path)
    const mod = this.byPath.get('module:' + path)
    if (mod) return mod
    // Closest containing folder.
    let best: MapNode | undefined
    for (const [p, n] of this.byPath) if (path.startsWith(p + '/') && (!best || p.length > best.path.length)) best = n
    return best
  }

  // ---------- drawing ----------

  private drawBoxes() {
    const g = this.boxes
    g.clear()
    for (const n of this.nodes) {
      if (n.kind === 'root' || n.kind === 'file') continue
      g.rect(n.x, n.y, n.w, n.h).fill({ color: n.kind === 'module' ? moduleTint(n.module, this.a.model.modules.find((m) => m.id === n.module)?.modeled) : C.dir })
      g.rect(n.x, n.y, n.w, n.h).stroke({ width: 1, color: n.kind === 'module' ? C.moduleBorder : C.dirBorder, pixelLine: true })
    }
    const f = this.filesG
    f.clear()
    const dim = this.opts.dimUnchanged
    for (const n of this.fileNodes) {
      const info = this.a.files[n.file!]
      let color = info.test ? C.fileTest : C.file
      let alpha = dim ? 0.35 : 1
      if (this.opts.showImpacted && this.impacted.has(n.file!)) { color = C.impacted; alpha = 1 }
      if (info.status === 'added') { color = C.added; alpha = 1 }
      else if (info.status === 'modified' || info.status === 'renamed') {
        color = C.modified
        alpha = 0.45 + 0.55 * Math.min(1, (info.add + info.del) / Math.max(30, info.lines * 0.6))
      } else if (info.status === 'deleted') { color = C.deleted; alpha = 0.25 }
      f.rect(n.x, n.y, n.w, n.h).fill({ color, alpha })
      if (info.status === 'deleted') f.rect(n.x, n.y, n.w, n.h).stroke({ width: 1, color: C.deleted, pixelLine: true })
    }
  }

  schedule() {
    if (this.pending) return
    this.pending = true
    requestAnimationFrame(() => {
      this.pending = false
      this.drawDynamic()
    })
  }

  private screenSize(n: MapNode) {
    const s = this.viewport.scaled
    return { w: n.w * s, h: n.h * s }
  }

  private isOpen(n: MapNode) {
    if (n.kind === 'root') return true
    if (n.kind === 'file') return false
    const { w, h } = this.screenSize(n)
    return Math.min(w, h) >= OPEN_PX
  }

  /** The node that stands for this file at the current zoom: its first ancestor that isn't open. */
  private rep(file: number): MapNode {
    for (const n of this.ancestors[file]) if (!this.isOpen(n)) return n
    return this.ancestors[file][this.ancestors[file].length - 1]
  }

  private drawDynamic() {
    if (!this.a) return
    const vb = this.viewport.getVisibleBounds()
    const s = this.viewport.scaled
    this.drawEdges(s)
    this.drawSelection(s)
    this.drawLabels(vb, s)
    this.drawDiffs(vb, s)
    const { level, trail } = this.level(vb)
    const key = level + trail.map((n) => n.id).join(',')
    if (key !== this.lastLevel) {
      this.lastLevel = key
      this.events.onView(level, trail)
    }
  }

  private edgeKind(e: FileEdge): 'violation' | 'added' | 'removed' | 'existing' | null {
    const a = this.a.files[e.from].module
    const b = this.a.files[e.to].module
    const violation = a !== b && this.violations.has(`${a}>${b}`)
    if (e.state === 'added') return violation ? 'violation' : 'added'
    if (e.state === 'removed') return 'removed'
    if (violation) return 'violation'
    return this.opts.showAllImports ? 'existing' : null
  }

  private drawEdges(s: number) {
    const g = this.edgesG
    g.clear()
    const agg = new Map<string, { a: MapNode; b: MapNode; kind: string; n: number }>()
    for (const e of this.a.edges) {
      const kind = this.edgeKind(e)
      if (!kind) continue
      const a = this.rep(e.from)
      const b = this.rep(e.to)
      if (a === b) continue
      // Inside one module only show new and removed edges once that module is open.
      const key = `${a.id}>${b.id}>${kind}`
      const cur = agg.get(key)
      if (cur) cur.n++
      else agg.set(key, { a, b, kind, n: 1 })
    }
    const order = { existing: 0, removed: 1, added: 2, violation: 3 } as Record<string, number>
    const list = [...agg.values()].sort((x, y) => order[x.kind] - order[y.kind])
    const he = this.highlightEdge
    const within = (n: MapNode) => this.highlight.some((h) => { for (let c: MapNode | null = n; c; c = c.parent) if (c === h) return true; return h.parent ? false : false })
    const focusing = this.focus && this.highlight.length > 0
    for (const { a, b, kind, n } of list) {
      const color = kind === 'violation' ? C.edgeViolation : kind === 'added' ? C.edgeAdded : kind === 'removed' ? C.edgeRemoved : C.edgeAll
      const emph = (he && a.module === he.from && b.module === he.to) || (focusing && within(a) && within(b))
      const px = (kind === 'existing' ? 0.8 : 1.6 + Math.min(3, Math.log2(n))) * (emph ? 1.8 : 1)
      const alpha = kind === 'existing' ? 0.35 : emph || (!he && !focusing) ? 0.9 : 0.25
      arrow(g, a, b, px / s, color, alpha, kind === 'removed')
    }
  }

  private drawSelection(s: number) {
    const g = this.selectG
    g.clear()
    for (const n of this.highlight) g.rect(n.x, n.y, n.w, n.h).stroke({ width: 2 / s, color: C.select, alpha: 0.7 })
    if (this.selected) g.rect(this.selected.x, this.selected.y, this.selected.w, this.selected.h).stroke({ width: 3 / s, color: C.select })
  }

  private visible(n: MapNode, vb: { x: number; y: number; width: number; height: number }) {
    return n.x < vb.x + vb.width && n.x + n.w > vb.x && n.y < vb.y + vb.height && n.y + n.h > vb.y
  }

  private drawLabels(vb: { x: number; y: number; width: number; height: number }, s: number) {
    let used = 0
    const put = (n: MapNode) => {
      const { w, h } = this.screenSize(n)
      if (w < 44 || h < 14) return
      const sx = (n.x - vb.x) * s
      const sy = (n.y - vb.y) * s
      let el = this.labelPool[used]
      if (!el) {
        el = document.createElement('div')
        this.labels.appendChild(el)
        this.labelPool.push(el)
      }
      used++
      el.className = 'label ' + n.kind + (n.changed ? ' changed' : '')
      const showStats = n.kind !== 'file' && n.changed > 0 && w > 120
      const info = n.kind === 'file' ? this.a.files[n.file!] : null
      const tag = info && info.status !== 'unchanged' ? ` <span class="st ${info.status}">${info.status === 'added' ? 'new' : info.status}</span>` : ''
      el.innerHTML = esc(n.name) + tag + (showStats ? ` <span class="ct">${n.changed} changed</span>` : '')
      el.style.transform = `translate(${Math.max(sx, 0) + 3}px, ${Math.max(sy, 0) + 2}px)`
      el.style.maxWidth = `${Math.max(w - 6, 30)}px`
      el.style.display = ''
    }
    const walk = (n: MapNode) => {
      if (!this.visible(n, vb)) return
      if (n.kind !== 'root') put(n)
      if (this.isOpen(n)) for (const c of n.children) walk(c)
    }
    walk(this.root)
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].style.display = 'none'
  }

  private drawDiffs(vb: { x: number; y: number; width: number; height: number }, s: number) {
    const keep = new Set<number>()
    for (const n of this.fileNodes) {
      const { w, h } = this.screenSize(n)
      if (w < DIFF_PX || h < 120 || !this.visible(n, vb)) continue
      const parent = n.parent
      if (parent && !this.isOpen(parent)) continue
      const f = this.a.files[n.file!]
      keep.add(n.file!)
      let el = this.diffEls.get(n.file!)
      if (!el) {
        el = document.createElement('div')
        el.className = 'diff'
        el.innerHTML = renderDiff(f)
        this.diffs.appendChild(el)
        this.diffEls.set(n.file!, el)
      }
      const sx = (n.x - vb.x) * s
      const sy = (n.y - vb.y) * s
      const top = Math.min(22, h * 0.1)
      el.style.transform = `translate(${sx}px, ${sy + top}px)`
      el.style.width = `${w}px`
      el.style.height = `${h - top}px`
      el.style.fontSize = `${Math.max(7, Math.min(15, w / 92))}px`
    }
    for (const [i, el] of this.diffEls) if (!keep.has(i)) { el.remove(); this.diffEls.delete(i) }
  }

  private level(vb: { x: number; y: number; width: number; height: number }): { level: Level; trail: MapNode[] } {
    const cx = vb.x + vb.width / 2
    const cy = vb.y + vb.height / 2
    const trail: MapNode[] = []
    let n: MapNode | undefined = this.root
    while (n) {
      trail.push(n)
      if (!this.isOpen(n)) break
      n = n.children.find((c) => cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h)
    }
    const last = trail[trail.length - 1]
    const open = trail.filter((t) => this.isOpen(t))
    const deepest = open[open.length - 1]
    let level: Level = 'System'
    if (last.kind === 'file') level = this.screenSize(last).w >= DIFF_PX ? 'Diff' : 'File'
    else if (deepest.kind === 'dir') level = 'Folder'
    else if (deepest.kind === 'module') level = 'Module'
    return { level, trail }
  }

  hit(x: number, y: number): MapNode | null {
    let n: MapNode = this.root
    let found: MapNode | null = null
    for (;;) {
      const c = n.children.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)
      if (!c) return found
      found = c
      if (!this.isOpen(c)) return c
      n = c
    }
  }
}

function moduleTint(id: string, modeled?: boolean): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const hue = h % 360
  return hslToHex(hue, modeled ? 0.32 : 0.12, 0.88)
}

function hslToHex(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}

/** Curved arrow between two boxes, clipped to their borders. */
function arrow(g: Graphics, a: MapNode, b: MapNode, width: number, color: number, alpha: number, dashed: boolean) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2
  const bx = b.x + b.w / 2, by = b.y + b.h / 2
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  const cx = (ax + bx) / 2 - (dy / len) * len * 0.18
  const cy = (ay + by) / 2 + (dx / len) * len * 0.18
  const [sx, sy] = clip(a, cx, cy)
  const [ex, ey] = clip(b, cx, cy)
  if (dashed) {
    const steps = 18
    for (let i = 0; i < steps; i += 2) {
      const [x0, y0] = quad(sx, sy, cx, cy, ex, ey, i / steps)
      const [x1, y1] = quad(sx, sy, cx, cy, ex, ey, (i + 1) / steps)
      g.moveTo(x0, y0).lineTo(x1, y1)
    }
  } else g.moveTo(sx, sy).quadraticCurveTo(cx, cy, ex, ey)
  g.stroke({ width, color, alpha, cap: 'round' })
  // Arrowhead along the curve's end tangent.
  const tx = ex - cx, ty = ey - cy
  const tl = Math.hypot(tx, ty) || 1
  const hl = width * 4.5
  const ux = tx / tl, uy = ty / tl
  g.poly([ex, ey, ex - ux * hl - uy * hl * 0.6, ey - uy * hl + ux * hl * 0.6, ex - ux * hl + uy * hl * 0.6, ey - uy * hl - ux * hl * 0.6]).fill({ color, alpha })
}

function quad(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number): [number, number] {
  const u = 1 - t
  return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]
}

/** Point where the segment from the box centre toward (px, py) leaves the box. */
function clip(n: MapNode, px: number, py: number): [number, number] {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2
  const dx = px - cx, dy = py - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const t = Math.min(Math.abs(n.w / 2 / (dx || 1e-9)), Math.abs(n.h / 2 / (dy || 1e-9)), 1)
  return [cx + dx * t, cy + dy * t]
}

export function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export function renderDiff(f: FileInfo): string {
  if (!f.hunks || f.hunks.length === 0) {
    return `<div class="meta">${f.status === 'unchanged' ? 'Unchanged' : f.status} · ${f.lines} lines</div>`
  }
  const out: string[] = []
  for (const h of f.hunks) {
    out.push(`<div class="hh">${esc(h.header)}</div>`)
    for (const l of h.lines) out.push(`<div class="l ${l.t === '+' ? 'a' : l.t === '-' ? 'd' : 'c'}">${esc(l.s) || ' '}</div>`)
  }
  return out.join('')
}
