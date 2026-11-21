// The zoomable map. WebGL draws the boxes (a retained rectangle layer) on one canvas, under the diffs, and the
// arrows and outlines (immediate triangles) on a second, transparent canvas above them, so an arrow into a file
// you're reading isn't hidden by its text. DOM layers draw the text: labels stay a fixed screen size, diffs scale
// with their box.
// No rendering or camera library: see web/gl/.

import type { Analysis, FileEdge, FileInfo, FileRole } from '../shared/types.ts'
import { buildMap, COL_W, roleOf, type MapNode } from './layout.ts'
import { Camera, type Rect } from './gl/camera.ts'
import { attachInput } from './gl/input.ts'
import { rgba } from './gl/program.ts'
import { RectLayer } from './gl/rects.ts'
import { Shapes } from './gl/shapes.ts'
import { renderDiffView } from './diffView.ts'

/** A node opens (shows its children) once it is this many pixels on its short side. */
const OPEN_PX = 170
/**
 * Diff text is the same size in every file at a given zoom, as on a map: zooming makes all of it bigger
 * together, and a bigger box shows more of its file rather than bigger letters. The size is a scale of the
 * 12px text the CSS sets: 1 when a file of the median width is DIFF_W px wide on screen.
 */
const DIFF_W = 560
/** Text this small isn't drawn; it fades in up to DIFF_TEXT_FULL (about 3px to 7px text). */
const DIFF_TEXT_FROM = 0.25
const DIFF_TEXT_FULL = 0.55
/**
 * Diffs are switched on (invisibly) from DIFF_WARM_FROM, a few per frame, so they're already painted when the text
 * appears; and stay on until the text scale drops below DIFF_WARM_OFF.
 */
const DIFF_WARM_FROM = DIFF_TEXT_FROM * 0.55
const DIFF_WARM_OFF = DIFF_TEXT_FROM * 0.4
const DIFF_WARM_PER_FRAME = 2
/** Past this the text stops growing and more of each line shows instead. */
const DIFF_MAX_SCALE = 1.6
/** Text px at the top of a file's box kept for its label (see drawDiffs). */
const FILE_LABEL_ROOM = 22
/** A box narrower than this many characters of text stays a coloured block. */
const DIFF_MIN_CHARS = 30 // the line-number gutter takes about 11 of them
const CHAR_PX = 7.2 // a 12px monospace character
/** Labels fade in between these widths, instead of popping. */
const LABEL_FROM_PX = 40
const LABEL_FULL_PX = 72
/** Wheel events further apart than this start a new gesture (as in gl/input.ts). */
const WHEEL_GESTURE_GAP_MS = 200
/** How long after the camera stops the text goes back from GPU layers to sharp rendering. */
const SETTLE_MS = 160
/** The selected box's outline, in CSS px. */
const SELECT_PX = 3
/** How long the camera takes to fly to something. */
const FLY_MS = 650

export type Level = 'System' | 'Module' | 'Folder' | 'File' | 'Diff'

export interface MapOptions {
  showAllImports: boolean
  showImpacted: boolean
  dimUnchanged: boolean
  /** tests (unit and e2e) on the map */
  showTests: boolean
  /** translation files on the map */
  showLocales: boolean
  /** files the branch doesn't touch on the map */
  showUnchanged: boolean
}

export interface MapEvents {
  onSelect(node: MapNode | null): void
  onView(level: Level, trail: MapNode[]): void
  /** a change card on the map was clicked (index into analysis.changes.items, or -1 for "not described") */
  onChange(i: number): void
}

/** A described change, placed on the map. */
interface ChangeCard {
  i: number
  nodes: MapNode[]
  el: HTMLElement
  /** anchor in world coordinates: the centre of its files */
  x: number
  y: number
  /**
   * where the card's centre sits, in world coordinates: chosen once at the whole-map zoom (see placeCards), so the
   * card moves with the map and never relative to it; null when there was no room for it near its code
   */
  at: { x: number; y: number } | null
  /** its size in CSS px, measured when placed (a hidden card measures 0, so it's never re-measured per frame) */
  w: number
  h: number
}

/** A file's diff element. Built once (ahead of time, see prebuildDiffs) and hidden rather than removed. */
interface DiffEl {
  el: HTMLElement
  /** its text scale */
  k: number
  /** how much of the box is above the window, in text px */
  hidden: number
  /** how far the reader has scrolled it, on top of what moving the box does */
  offset: number
  /** on screen this frame */
  shown: boolean
}

interface View {
  x: number
  y: number
  width: number
  height: number
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

/**
 * Writes a style only when its value changed. An unchanged write still costs the browser a style pass, and a size
 * written just before a scroll position forces a layout on the spot: done for every diff and label each frame,
 * that's what made zooming hitch.
 */
const written = new WeakMap<HTMLElement, Record<string, string>>()
function setStyle(el: HTMLElement, prop: 'transform' | 'width' | 'height' | 'maxWidth' | 'opacity' | 'display' | 'visibility', value: string) {
  let m = written.get(el)
  if (!m) written.set(el, (m = {}))
  if (m[prop] === value) return
  m[prop] = value
  el.style[prop] = value
}
function setClass(el: HTMLElement, value: string) {
  if (el.className !== value) el.className = value
}
/** Sets scrollTop only when it moves by a pixel or more (a write forces a layout). */
function setScroll(el: HTMLElement, top: number) {
  if (Math.abs(el.scrollTop - top) >= 1) el.scrollTop = top
}
const px = (v: number) => `${Math.round(v * 2) / 2}px`

/** Runs `cb` when the browser is idle (Safari has no requestIdleCallback: a short timeout stands in). */
function idle(cb: (deadline: { timeRemaining(): number }) => void) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(cb, { timeout: 1000 })
  else setTimeout(() => {
    const start = performance.now()
    cb({ timeRemaining: () => Math.max(0, 8 - (performance.now() - start)) })
  }, 16)
}

/** The label fonts, as the CSS sets them (.label.module, .label.dir, .label.file, .st, .ct), for measuring. */
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const LABEL_FONT = {
  module: { name: `700 15px ${SANS}`, extra: `400 12.75px ${SANS}` },
  dir: { name: `600 11px ${SANS}`, extra: `400 9.35px ${SANS}` },
  file: { name: `400 10.5px ${MONO}`, extra: `400 8.9px ${MONO}` },
}
const TAG_FONT = `600 9.5px ${SANS}`

/** A string's width in a font, in CSS px (measured once, then remembered). */
const textWidth = (() => {
  let ctx: CanvasRenderingContext2D | null = null // made on first use, so importing this module needs no DOM
  const cache = new Map<string, number>()
  return (text: string, font: string) => {
    const key = font + '|' + text
    let w = cache.get(key)
    if (w === undefined) {
      ctx ??= document.createElement('canvas').getContext('2d')!
      ctx.font = font
      w = ctx.measureText(text).width
      cache.set(key, w)
    }
    return w
  }
})()

const smoothstep = (from: number, to: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

export class ZoomMap {
  readonly camera = new Camera()
  a!: Analysis
  root!: MapNode
  nodes: MapNode[] = []
  fileNodes: MapNode[] = []
  byPath = new Map<string, MapNode>()
  ancestors: MapNode[][] = []
  impacted = new Set<number>()
  violations = new Set<string>()
  opts: MapOptions = { showAllImports: false, showImpacted: true, dimUnchanged: false, showTests: false, showLocales: false, showUnchanged: false }
  selected: MapNode | null = null
  highlight: MapNode[] = []
  highlightEdge: { from: string; to: string } | null = null
  focus = false

  private canvas = document.createElement('canvas')
  private gl!: WebGL2RenderingContext
  /** above the diffs: arrows and outlines */
  private overlay = document.createElement('canvas')
  private overlayGl!: WebGL2RenderingContext
  private rects!: RectLayer
  private shapes!: Shapes
  private labels: HTMLElement
  private diffs: HTMLElement
  private labelPool: HTMLElement[] = []
  private changesLayer: HTMLElement
  private cards: ChangeCard[] = []
  /** whether placeCards has run for this layout and whole-map zoom */
  private cardsPlaced = false
  /** the scale that fits the whole map; change cards show near it and fade as you zoom in */
  private fitScale = 1
  /** looking at something (a change, a finding): the cards step aside until Esc or Whole map */
  private zoomed = false
  /**
   * Diffs on screen, by file index. Each is drawn only over the part of its box that's on screen (see drawDiffs):
   * `k` is its text scale, `hidden` how much of the box is above the window (in text px), and `offset` how far
   * the reader has scrolled it, on top of what moving the box does.
   */
  private diffEls = new Map<number, DiffEl>()
  /** bumped on every load, so a pre-build still running for the last analysis stops */
  private buildGeneration = 0
  /** median file width in world units: what the diff text size is measured against */
  private medianFileW = 1
  private pending = false
  private lastFrame = 0
  private lastLevel = ''
  private lastCamera = ''
  /** diffs are switched on (warming up or showing): see drawDiffs */
  private textWarm = false
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  /** the current wheel gesture: when its last event came, and the file it's scrolling (null: the map) */
  private wheelGesture = { last: -Infinity, file: null as number | null }
  private userMoved = false

  constructor(private host: HTMLElement, private events: MapEvents) {
    this.labels = document.createElement('div')
    this.labels.className = 'labels'
    this.diffs = document.createElement('div')
    this.diffs.className = 'diffs'
    this.changesLayer = document.createElement('div')
    this.changesLayer.className = 'changes'
  }

  async init() {
    const gl = this.canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false })
    if (!gl) throw new Error('WebGL 2 is not available')
    this.gl = gl
    this.rects = new RectLayer(gl)
    const overlayGl = this.overlay.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true })
    if (!overlayGl) throw new Error('WebGL 2 is not available')
    this.overlayGl = overlayGl
    this.shapes = new Shapes(overlayGl)
    this.overlay.className = 'overlay'
    this.host.appendChild(this.canvas)
    this.host.appendChild(this.diffs)
    this.host.appendChild(this.overlay)
    this.host.appendChild(this.labels)
    this.host.appendChild(this.changesLayer)
    attachInput(this.host, this.camera, {
      changed: () => {
        this.userMoved = true
        this.schedule()
      },
      click: (x, y, double) => {
        const w = this.camera.toWorld(x, y)
        const n = this.hit(w.x, w.y)
        if (double && n) {
          // A double-click reads the box (and keeps it selected, though its first click may have just unselected it).
          this.select(n)
          this.readBox(n)
        } else if (n && n === this.selected) this.clearSelection() // clicking the selected box again unselects it
        else this.select(n)
      },
      wheel: (e, _x, _y, _dx, dy) => this.scrollDiff(e, dy),
    })
    const resize = () => {
      const c = this.camera
      c.width = this.host.clientWidth
      c.height = this.host.clientHeight
      c.dpr = window.devicePixelRatio || 1
      // Setting a canvas's size wipes it (even to the same size), and an opaque canvas shows the wipe as black. So
      // only resize when the size changed, and redraw right here: ResizeObserver runs after layout but before the
      // browser paints, so the new size and the new picture reach the screen together, with no black frame between.
      const w = Math.round(c.width * c.dpr)
      const h = Math.round(c.height * c.dpr)
      for (const canvas of [this.canvas, this.overlay]) {
        if (canvas.width !== w) canvas.width = w
        if (canvas.height !== h) canvas.height = h
        canvas.style.width = c.width + 'px'
        canvas.style.height = c.height + 'px'
      }
      if (this.a) this.drawBoxes() // borders are a device pixel, which depends on dpr
      if (!this.userMoved && this.root) this.fitAll(false)
      if (this.a) this.frame()
      this.schedule()
    }
    new ResizeObserver(resize).observe(this.host)
    resize()
  }

  load(a: Analysis) {
    this.a = a
    const hide = new Set<FileRole>()
    if (!this.opts.showTests) hide.add('test')
    if (!this.opts.showLocales) hide.add('locale')
    // The column layout takes the map's shape and sizes its label strips for the whole-map view.
    const view = { width: this.camera.width, height: this.camera.height }
    const m = buildMap(a, hide, this.opts.showUnchanged ? undefined : touched(a, this.opts.showImpacted, hide), view)
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
    for (const { el } of this.diffEls.values()) el.remove()
    this.diffEls.clear()
    this.buildGeneration++
    const widths = this.fileNodes.map((n) => n.w).sort((x, y) => x - y)
    // In the column view boxes widen to fill space, but the text shouldn't grow with them: measure it against the
    // column width. In the treemap, against the median file.
    this.medianFileW = this.opts.showUnchanged ? (widths[Math.floor(widths.length / 2)] ?? 1) : COL_W
    this.prebuildDiffs()
    this.drawBoxes()
    this.buildCards()
    this.userMoved = false
    this.fitAll(false)
  }

  /** Nodes for some files (those on the map now). */
  nodesFor(paths: string[]): MapNode[] {
    return paths.flatMap((p) => {
      const n = this.byPath.get(p)
      return n && n.kind === 'file' ? [n] : []
    })
  }

  /** Outline some nodes without moving the view (hovering a change). */
  mark(nodes: MapNode[]) {
    this.highlight = nodes
    this.highlightEdge = null
    this.focus = false
    this.schedule()
  }

  private buildCards() {
    this.changesLayer.textContent = ''
    this.cards = []
    const cs = this.a.changes
    if (!cs) return
    const make = (i: number, title: string, files: string[], cls: string) => {
      const nodes = this.nodesFor(files)
      if (!nodes.length) return
      // Anchor: the area-weighted centre of its files, so a change lands where most of its code is.
      let sx = 0, sy = 0, sw = 0
      for (const n of nodes) {
        const area = n.w * n.h
        sx += (n.x + n.w / 2) * area
        sy += (n.y + n.h / 2) * area
        sw += area
      }
      const el = document.createElement('button')
      el.className = 'change-card ' + cls
      el.innerHTML = `<span class="n">${i < 0 ? '!' : i + 1}</span>${esc(title)}`
      el.onmouseenter = () => this.mark(nodes)
      el.onmouseleave = () => this.mark([])
      el.onclick = () => this.events.onChange(i)
      this.changesLayer.appendChild(el)
      this.cards.push({ i, nodes, el, x: sx / sw, y: sy / sw, at: null, w: 0, h: 0 })
    }
    this.cardsPlaced = false
    cs.items.forEach((c, i) => make(i, c.title, c.files, ''))
    if (cs.undescribed.length) {
      const files = [...new Set(cs.undescribed.map((h) => h.slice(0, h.lastIndexOf('#'))))]
      make(-1, `Not described: ${cs.undescribed.length} hunk${cs.undescribed.length === 1 ? '' : 's'}`, files, 'gap')
    }
  }

  /** Change cards: full strength when the whole map is in view, gone by the time files are readable. */
  private drawCards(vb: View, s: number) {
    const t = (s / this.fitScale - 1.4) / 1.2 // 0 at 1.4× the fit scale, 1 at 2.6×
    const opacity = this.zoomed || this.selected ? 0 : Math.max(0, Math.min(1, 1 - t))
    this.changesLayer.style.opacity = String(opacity)
    this.changesLayer.style.display = opacity === 0 ? 'none' : ''
    if (opacity === 0) return
    if (!this.cardsPlaced) this.placeCards()
    // Each card sits where placeCards put it, moving with the map. Zoomed in, cards only spread apart; zoomed out
    // past the whole-map view they could meet, and then the later (less significant) one hides rather than moving.
    const shown: { x0: number; y0: number; x1: number; y1: number }[] = []
    for (const c of this.cards) {
      if (!c.at) {
        c.el.style.display = 'none'
        continue
      }
      const { w, h } = c
      const x0 = (c.at.x - vb.x) * s - w / 2
      const y0 = (c.at.y - vb.y) * s - h / 2
      c.el.style.display = ''
      c.el.style.transform = `translate(${x0}px, ${y0}px)`
      // Fades out (and stops taking clicks) instead of blinking off; its size is fixed, so at a given zoom the
      // answer is always the same and it can't flicker.
      const covered = shown.some((p) => x0 < p.x1 && x0 + w > p.x0 && y0 < p.y1 && y0 + h > p.y0)
      c.el.classList.toggle('covered', covered)
      if (!covered) shown.push({ x0, y0, x1: x0 + w, y1: y0 + h })
    }
  }

  /**
   * Chooses each card's spot once, at the whole-map zoom: as near its code as it fits without covering a card
   * already placed (most significant first), searching only a little way out. A card with no room nearby isn't
   * shown, rather than parked somewhere far from what it describes; the panel still lists every change.
   */
  private placeCards() {
    this.cardsPlaced = true
    const s = this.fitScale
    const r = { x: this.root.x, y: this.root.y, w: this.root.w, h: this.root.h }
    const view = this.camera.fitted(r)
    const W = this.camera.width
    const H = this.camera.height
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
    for (const c of this.cards) {
      c.el.style.display = ''
      c.el.classList.remove('covered')
      const w = c.el.offsetWidth
      const h = c.el.offsetHeight
      c.w = w
      c.h = h
      c.at = null
      if (!w || !h) continue
      const ax = (c.x - view.x) * s - w / 2
      const ay = (c.y - view.y) * s - h / 2
      const free = (x0: number, y0: number) =>
        x0 >= 4 && y0 >= 4 && x0 + w <= W - 4 && y0 + h <= H - 4 &&
        !placed.some((p) => x0 < p.x1 + 4 && x0 + w > p.x0 - 4 && y0 < p.y1 + 4 && y0 + h > p.y0 - 4)
      // Nearest first: the anchor, then rings out to about one and a half card heights.
      search: for (let ring = 0; ring <= 6; ring++) {
        const d = ring * h * 0.25
        for (const [dx, dy] of [[0, 0], [0, d], [0, -d], [d * 1.6, 0], [-d * 1.6, 0], [d, d], [-d, d], [d, -d], [-d, -d]]) {
          if (ring === 0 && (dx || dy)) continue
          const x0 = ax + dx
          const y0 = ay + dy
          if (free(x0, y0)) {
            placed.push({ x0, y0, x1: x0 + w, y1: y0 + h })
            c.at = { x: view.x + (x0 + w / 2) / s, y: view.y + (y0 + h / 2) / s }
            break search
          }
        }
      }
    }
  }

  setOptions(o: Partial<MapOptions>) {
    const changes = (k: keyof MapOptions) => o[k] !== undefined && o[k] !== this.opts[k]
    const relayout =
      changes('showTests') || changes('showLocales') || changes('showUnchanged')
    Object.assign(this.opts, o)
    // Showing or hiding files changes the layout.
    if (relayout && this.a) return this.load(this.a)
    this.drawBoxes()
    this.schedule()
  }

  fitAll(animate = true) {
    if (animate) this.userMoved = false
    this.zoomed = false
    const r = { x: this.root.x, y: this.root.y, w: this.root.w, h: this.root.h }
    const fit = this.camera.fitted(r).scale
    if (Math.abs(fit - this.fitScale) > 1e-9) this.cardsPlaced = false // a new whole-map zoom: place the cards again
    this.fitScale = fit
    this.camera.minScale = this.fitScale * 0.3
    this.camera.fit(r, animate ? FLY_MS : 0)
    this.schedule()
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
    this.zoomed = true
    this.camera.fit({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, FLY_MS)
    this.schedule()
  }

  /**
   * Double-click: zoom so the box fills the window's width with its top at the window's top, the way you'd open
   * a page to read it. A file's diff starts from its first line.
   */
  readBox(n: MapNode) {
    this.zoomed = true
    this.highlight = []
    this.highlightEdge = null
    this.focus = false
    const d = n.file !== undefined ? this.diffEls.get(n.file) : undefined
    if (d) d.offset = 0
    // A negative margin: the box is a few px wider than the window and starts a few px above it, so its selection
    // outline (SELECT_PX, drawn inside the box's edge) sits just off screen instead of framing the text.
    this.camera.flyTo(this.camera.fittedWidth({ x: n.x, y: n.y, w: n.w, h: n.h }, -(SELECT_PX + 1)), FLY_MS)
    this.schedule()
  }

  /** Esc: drop the selection and whatever is highlighted, and leave the view where it is. */
  clearSelection() {
    this.highlight = []
    this.highlightEdge = null
    this.focus = false
    this.zoomed = false
    this.select(null)
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

  /** The boxes: rebuilt when the analysis or the options change, not when the camera moves. */
  private drawBoxes() {
    const r = this.rects
    r.clear()
    const dpr = this.camera.dpr
    for (const n of this.nodes) {
      if (n.kind === 'root' || n.kind === 'file') continue
      const fill = n.kind === 'module' ? moduleTint(n.module, this.a.model.modules.find((m) => m.id === n.module)?.modeled) : C.dir
      r.addBox(n.x, n.y, n.w, n.h, rgba(fill), rgba(n.kind === 'module' ? C.moduleBorder : C.dirBorder), dpr)
    }
    const dim = this.opts.dimUnchanged
    for (const n of this.fileNodes) {
      const info = this.a.files[n.file!]
      let color = info.test ? C.fileTest : C.file
      let alpha = dim ? 0.35 : 1
      if (this.opts.showImpacted && this.impacted.has(n.file!)) { color = C.impacted; alpha = 1 }
      if (info.status !== 'unchanged' && roleOf(info) !== 'source') {
        // Tests, translations, generated files: no tint (a faint one still reads as "modified" from far out).
        r.add(n.x, n.y, n.w, n.h, rgba(info.test ? C.fileTest : C.file, dim ? 0.35 : 1))
        continue
      }
      if (info.status === 'added') { color = C.added; alpha = 1 }
      else if (info.status === 'modified' || info.status === 'renamed') {
        color = C.modified
        alpha = 0.45 + 0.55 * Math.min(1, (info.add + info.del) / Math.max(30, info.lines * 0.6))
      } else if (info.status === 'deleted') {
        r.addBox(n.x, n.y, n.w, n.h, rgba(C.deleted, 0.25), rgba(C.deleted), dpr)
        continue
      }
      r.add(n.x, n.y, n.w, n.h, rgba(color, alpha))
    }
  }

  schedule() {
    if (this.pending) return
    this.pending = true
    requestAnimationFrame((now) => {
      this.pending = false
      const dt = this.lastFrame ? Math.min(50, now - this.lastFrame) : 16.7
      this.lastFrame = now
      const moving = this.camera.step(now, dt)
      this.frame()
      if (moving) this.schedule()
      else this.lastFrame = 0
    })
  }

  private screenSize(n: MapNode) {
    const s = this.camera.scale
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

  private frame() {
    if (!this.a) return
    const cam = this.camera
    this.noteMotion()
    const v = cam.view
    const vb: View = { x: v.x, y: v.y, width: v.w, height: v.h }
    const s = cam.scale
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(((C.bg >> 16) & 255) / 255, ((C.bg >> 8) & 255) / 255, (C.bg & 255) / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.rects.render(cam)
    const og = this.overlayGl
    og.viewport(0, 0, this.overlay.width, this.overlay.height)
    og.clearColor(0, 0, 0, 0)
    og.clear(og.COLOR_BUFFER_BIT)
    this.drawEdges()
    this.drawSelection()
    this.shapes.flush(this.overlay.width, this.overlay.height)
    const { level, trail } = this.level(vb)
    const path = new Set(trail)
    this.drawLabels(vb, s, path)
    this.drawDiffs(vb, s, path)
    this.drawCards(vb, s)
    const key = level + trail.map((n) => n.id).join(',')
    if (key !== this.lastLevel) {
      this.lastLevel = key
      this.events.onView(level, trail)
    }
  }

  /**
   * While the camera moves, the text layers are GPU layers (#map.moving, see style.css): scaling one is then
   * moving a picture, not re-rendering every line of code each frame. Shortly after it stops they go back to
   * ordinary layers and render once, sharp.
   */
  private noteMotion() {
    const c = this.camera
    const key = `${c.x.toFixed(3)},${c.y.toFixed(3)},${c.scale.toFixed(5)}`
    if (key === this.lastCamera) return
    this.lastCamera = key
    this.host.classList.add('moving')
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => this.host.classList.remove('moving'), SETTLE_MS)
  }

  private edgeKind(e: FileEdge): 'violation' | 'added' | 'removed' | 'existing' | null {
    const a = this.a.files[e.from].module
    const b = this.a.files[e.to].module
    const source = roleOf(this.a.files[e.from]) === 'source'
    const violation = a !== b && source && this.violations.has(`${a}>${b}`)
    // New imports from tests, translations or generated files aren't part of the footprint.
    if (!source && e.state !== 'both') return null
    if (e.state === 'added') return violation ? 'violation' : 'added'
    if (e.state === 'removed') return 'removed'
    if (violation) return 'violation'
    return this.opts.showAllImports ? 'existing' : null
  }

  private drawEdges() {
    const agg = new Map<string, { a: MapNode; b: MapNode; kind: string; n: number }>()
    // Arrows only on request: for the selected file or folder, or the finding being looked at.
    // ("All imports" still shows every arrow.)
    const under = (file: number, n: MapNode) => this.ancestors[file].includes(n)
    const sel = this.selected
    const he = this.highlightEdge
    const focusing = this.focus && this.highlight.length > 0
    const wanted = (e: FileEdge): 'yes' | 'with-existing' | false => {
      if (this.opts.showAllImports) return 'yes'
      if (sel && (under(e.from, sel) || under(e.to, sel))) return sel.kind === 'file' ? 'with-existing' : 'yes'
      if (he && this.a.files[e.from].module === he.from && this.a.files[e.to].module === he.to) return 'yes'
      if (focusing && this.highlight.some((h) => under(e.from, h)) && this.highlight.some((h) => under(e.to, h))) return 'yes'
      return false
    }
    for (const e of this.a.edges) {
      if (!this.ancestors[e.from] || !this.ancestors[e.to]) continue // a hidden file
      const want = wanted(e)
      if (!want) continue
      // A selected file also shows the imports it already had, faintly, so you can see what it's connected to.
      const kind = this.edgeKind(e) ?? (want === 'with-existing' ? 'existing' : null)
      if (!kind) continue
      const a = this.rep(e.from)
      const b = this.rep(e.to)
      if (a === b) continue
      const key = `${a.id}>${b.id}>${kind}`
      const cur = agg.get(key)
      if (cur) cur.n++
      else agg.set(key, { a, b, kind, n: 1 })
    }
    const order = { existing: 0, removed: 1, added: 2, violation: 3 } as Record<string, number>
    const list = [...agg.values()].sort((x, y) => order[x.kind] - order[y.kind])
    const within = (n: MapNode) => this.highlight.some((h) => { for (let c: MapNode | null = n; c; c = c.parent) if (c === h) return true; return false })
    for (const { a, b, kind, n } of list) {
      const color = kind === 'violation' ? C.edgeViolation : kind === 'added' ? C.edgeAdded : kind === 'removed' ? C.edgeRemoved : C.edgeAll
      const emph = (he && a.module === he.from && b.module === he.to) || (focusing && within(a) && within(b))
      const px = (kind === 'existing' ? 0.8 : 1.6 + Math.min(3, Math.log2(n))) * (emph ? 1.8 : 1)
      const alpha = kind === 'existing' ? 0.35 : emph || (!he && !focusing) ? 0.9 : 0.25
      this.arrow(a, b, px, rgba(color, alpha), kind === 'removed')
    }
  }

  /** Curved arrow between two boxes, clipped to their borders. Width in CSS px. */
  private arrow(a: MapNode, b: MapNode, widthCss: number, color: number, dashed: boolean) {
    const cam = this.camera
    const k = cam.scale * cam.dpr
    const dev = (x: number, y: number): [number, number] => [(x - cam.x) * k, (y - cam.y) * k]
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2
    const bx = b.x + b.w / 2, by = b.y + b.h / 2
    const dx = bx - ax, dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    const cx = (ax + bx) / 2 - (dy / len) * len * 0.18
    const cy = (ay + by) / 2 + (dx / len) * len * 0.18
    const [sx, sy] = clip(a, cx, cy)
    const [ex, ey] = clip(b, cx, cy)
    const width = widthCss * cam.dpr
    const steps = 24
    if (dashed) {
      for (let i = 0; i < steps; i += 2) {
        const p = dev(...quad(sx, sy, cx, cy, ex, ey, i / steps))
        const q = dev(...quad(sx, sy, cx, cy, ex, ey, (i + 1) / steps))
        this.shapes.line(p[0], p[1], q[0], q[1], width, color)
      }
    } else {
      const pts: number[] = []
      for (let i = 0; i <= steps; i++) pts.push(...dev(...quad(sx, sy, cx, cy, ex, ey, i / steps)))
      this.shapes.polyline(pts, width, color)
    }
    // Arrowhead along the curve's end tangent.
    const [hx, hy] = dev(ex, ey)
    const [tcx, tcy] = dev(cx, cy)
    const tx = hx - tcx, ty = hy - tcy
    const tl = Math.hypot(tx, ty) || 1
    const hl = width * 4.5
    const ux = tx / tl, uy = ty / tl
    this.shapes.triangle(hx, hy, hx - ux * hl - uy * hl * 0.6, hy - uy * hl + ux * hl * 0.6, hx - ux * hl + uy * hl * 0.6, hy - uy * hl - ux * hl * 0.6, color)
  }

  private drawSelection() {
    const cam = this.camera
    const k = cam.scale * cam.dpr
    const box = (n: MapNode, widthCss: number, color: number) =>
      this.shapes.outline((n.x - cam.x) * k, (n.y - cam.y) * k, n.w * k, n.h * k, widthCss * cam.dpr, color)
    for (const n of this.highlight) box(n, 2, rgba(C.select, 0.7))
    if (this.selected) box(this.selected, SELECT_PX, rgba(C.select))
  }

  private visible(n: MapNode, vb: View) {
    return n.x < vb.x + vb.width && n.x + n.w > vb.x && n.y < vb.y + vb.height && n.y + n.h > vb.y
  }

  /**
   * `inHeader`: the breadcrumb path. A node on it whose box runs off the top of the window would have its label
   * pinned to the window's top, floating over the text you're reading; the header names it instead, so it's skipped.
   */
  private drawLabels(vb: View, s: number, inHeader: Set<MapNode>) {
    let used = 0
    const textShowing = this.textScale() >= DIFF_TEXT_FROM
    type Box = { x0: number; y0: number; x1: number; y1: number }
    /** Draws n's label below any ancestor label it would land on; returns where it went (null: not drawn). */
    const put = (n: MapNode, above: Box[]): Box | null => {
      const { w, h } = this.screenSize(n)
      if (w < LABEL_FROM_PX || h < 14) return null
      // A box whose top has gone above the window would get its label pinned to the window's top edge, floating
      // over the text. On the breadcrumb path the header names it; and once diff text is showing, no label floats.
      if (n.y < vb.y && (inHeader.has(n) || textShowing)) return null
      // The file you're reading (selected, or on the breadcrumb path) is named in the header: no label line over it.
      if (this.reading(n, inHeader)) return null
      const sx = Math.max((n.x - vb.x) * s, 0) + 3
      let sy = Math.max((n.y - vb.y) * s, 0) + 2
      const lineH = n.kind === 'module' ? 19 : 14
      // A folder's or module's label goes in the strip above its contents. Zoomed out that strip is a few pixels,
      // so the label would sit on its files: then, once its files are big enough to be named, theirs win and this
      // one waits until the strip can hold it. (While nothing inside is labelled, it can sit over the boxes.)
      if (n.kind !== 'file' && n.children.length) {
        const strip = (Math.min(...n.children.map((c) => c.y)) - n.y) * s
        const named = n.children.some((c) => {
          const cs = this.screenSize(c)
          return cs.w >= LABEL_FROM_PX && cs.h >= 14
        })
        if (named && strip < lineH + 2) return null
      }
      // Only the part of the box that's on screen is the label's to use: when the box runs off the left edge the label
      // is pulled in to the window's edge, and must still stop at the box's right side, not spill into the next box.
      const boxRight = (n.x + n.w - vb.x) * s
      const avail = boxRight - sx - 3
      if (avail < 24) return null
      let el = this.labelPool[used]
      if (!el) {
        el = document.createElement('div')
        this.labels.appendChild(el)
        this.labelPool.push(el)
      }
      used++
      setClass(el, 'label ' + n.kind + (n.changed ? ' changed' : ''))
      // The name comes first and is only cut when it alone doesn't fit. Extras (a file's status tag, a folder's
      // counts) are added, in order, only while they fit beside the whole name.
      const font = LABEL_FONT[n.kind as 'module' | 'dir' | 'file']
      let taken = textWidth(n.name, font.name)
      let html = esc(n.name)
      const extra = (text: string, cls: string, widthOf: number) => {
        if (taken + widthOf > avail) return false
        taken += widthOf
        html += ` <span class="${cls}">${esc(text)}</span>`
        return true
      }
      const info = n.kind === 'file' ? this.a.files[n.file!] : null
      if (info && info.status !== 'unchanged') {
        const t = info.status === 'added' ? 'new' : info.status
        extra(t, 'st ' + info.status, textWidth(t.toUpperCase(), TAG_FONT) + 8 + 4)
      }
      if (n.kind !== 'file' && n.changed > 0) {
        const t = `${n.changed} changed`
        if (extra(t, 'ct', textWidth(t, font.extra) + 4) && n.other > 0) {
          const o = `+${n.other} tests/translations`
          extra(o, 'ct other', textWidth(o, font.extra) + 4)
        }
      }
      // Labels are a fixed screen size but the room above a box's contents is in map units, so zoomed out a label
      // can land on an ancestor's: then it moves down just below it, if the box still has room for it.
      const right = sx + Math.min(taken + 4, avail)
      for (const b of above) if (sx < b.x1 && right > b.x0 && sy < b.y1 && sy + lineH > b.y0) sy = b.y1 + 1
      const boxBottom = (n.y - vb.y) * s + h
      if (sy + lineH > boxBottom) {
        used--
        setStyle(el, 'display', 'none')
        return null
      }
      if (el.dataset.html !== html) {
        el.innerHTML = html
        el.dataset.html = html
      }
      setStyle(el, 'transform', `translate(${px(sx)}, ${px(sy)})`)
      setStyle(el, 'maxWidth', px(avail))
      setStyle(el, 'opacity', smoothstep(LABEL_FROM_PX, LABEL_FULL_PX, Math.min(w, h * 3)).toFixed(2))
      setStyle(el, 'display', '')
      return { x0: sx, y0: sy, x1: right, y1: sy + lineH }
    }
    const walk = (n: MapNode, above: Box[]) => {
      if (!this.visible(n, vb)) return
      let mine = above
      if (n.kind !== 'root') {
        const b = put(n, above)
        if (b) mine = [...above, b]
      }
      // Down to any box big enough for its own label (put() checks), not only inside open ones: in the column view a
      // file is wide enough to name well before its folder counts as open.
      for (const c of n.children) {
        const { w, h } = this.screenSize(c)
        if (w >= LABEL_FROM_PX && h >= 14) walk(c, mine)
      }
    }
    walk(this.root, [])
    for (let i = used; i < this.labelPool.length; i++) setStyle(this.labelPool[i], 'display', 'none')
  }

  /** The diff text's scale at the current zoom (see DIFF_W). */
  private textScale(): number {
    return Math.min((this.camera.scale * this.medianFileW) / DIFF_W, DIFF_MAX_SCALE)
  }

  /**
   * Diffs, drawn inside their file's box, all at one text size for the zoom (textScale). They fade in over the
   * coloured boxes together as you zoom, instead of appearing at a threshold.
   */
  /** The file being read: selected, or on the breadcrumb path, with its text showing. The header names it. */
  private reading(n: MapNode, path: Set<MapNode>): boolean {
    return n.kind === 'file' && (this.selected === n || path.has(n)) && this.textScale() >= DIFF_TEXT_FROM
  }

  private drawDiffs(vb: View, s: number, path: Set<MapNode>) {
    const keep = new Set<number>()
    const k = this.textScale()
    // Text first painted the frame it appears means every diff on screen painting at once: a stall right at the
    // threshold, on every pass. So diffs are switched on a little below it, a couple per frame, at an opacity too
    // low to see but not zero (fully transparent text isn't painted), and stay on until you zoom well back out.
    if (k >= DIFF_WARM_FROM) this.textWarm = true
    else if (k < DIFF_WARM_OFF) this.textWarm = false
    const opacity = Math.max(0.01, smoothstep(DIFF_TEXT_FROM, DIFF_TEXT_FULL, k))
    let revealed = 0
    let pending = false
    for (const n of this.fileNodes) {
      if (!this.textWarm) break
      const { w, h } = this.screenSize(n)
      if (w < DIFF_MIN_CHARS * CHAR_PX * k || h < 40 || !this.visible(n, vb)) continue
      const parent = n.parent
      if (parent && !this.isOpen(parent)) continue
      if (!this.diffEls.get(n.file!)?.shown && k < DIFF_TEXT_FROM) {
        // Warming up: a couple of new ones a frame, so the painting is spread out.
        if (revealed >= DIFF_WARM_PER_FRAME) {
          pending = true
          continue
        }
        revealed++
      }
      keep.add(n.file!)
      const d = this.diffFor(n)
      const sx = (n.x - vb.x) * s
      const sy = (n.y - vb.y) * s
      const top = this.reading(n, path) ? 0 : Math.min(FILE_LABEL_ROOM, h * 0.1) // room for the file's label, if it has one
      // Window the text to the part of the box that's on screen. Unscrolled, the text moves with the box as if it
      // weren't cut off (scrollTop follows what's gone above the window); scrolled, it can reach anywhere in the
      // window: the first line down to the window's top, the last up to its bottom.
      const boxTop = sy + top
      const visTop = Math.max(boxTop, 0)
      const visBottom = Math.min(sy + h, this.camera.height)
      if (visBottom - visTop < 8) { keep.delete(n.file!); continue }
      d.k = k
      d.hidden = (visTop - boxTop) / k
      // The selected file is windowed sideways too: its text wraps at the window's edge, so every line you're
      // reading is on screen. Others wrap to their box, so they don't rewrap as you pan past them.
      const selected = this.selected === n
      const visLeft = selected ? Math.max(sx, 0) : sx
      const visRight = selected ? Math.min(sx + w, this.camera.width) : sx + w
      if (visRight - visLeft < DIFF_MIN_CHARS * CHAR_PX * k) { keep.delete(n.file!); continue }
      const el = d.el
      setStyle(el, 'transform', `translate(${px(visLeft)}, ${px(visTop)}) scale(${k.toFixed(4)})`)
      setStyle(el, 'width', px((visRight - visLeft) / k))
      setStyle(el, 'height', px((visBottom - visTop) / k))
      setScroll(el, d.hidden + d.offset)
      setStyle(el, 'opacity', opacity.toFixed(2))
      setClass(el, this.selected === n ? 'diff diffview selected' : 'diff diffview')
      if (!d.shown) {
        setStyle(el, 'visibility', '')
        d.shown = true
      }
    }
    // Hidden, not removed: showing it again is only a repaint, and it keeps its scroll and expanded gaps.
    for (const [i, d] of this.diffEls) {
      if (keep.has(i) || !d.shown) continue
      setStyle(d.el, 'visibility', 'hidden')
      d.shown = false
    }
    // More to warm up: keep going next frame, even if the camera has stopped.
    if (pending) this.schedule()
  }

  /** A file's diff element, built now if the pre-build hasn't reached it yet. */
  private diffFor(n: MapNode): DiffEl {
    let d = this.diffEls.get(n.file!)
    if (d) return d
    const el = document.createElement('div')
    el.className = 'diff'
    setStyle(el, 'visibility', 'hidden')
    // Laid out at the width it will have on screen (with the text scale below its cap), so showing it is a repaint.
    el.style.width = `${(n.w * DIFF_W) / this.medianFileW}px`
    el.style.height = `${(n.h * DIFF_W) / this.medianFileW}px`
    const view = renderDiffView(el, this.a.files[n.file!])
    this.diffs.appendChild(el)
    // A box packing made taller than its diff: fill it with the code around the change instead of blank space.
    view.fill(n.h * (DIFF_W / this.medianFileW) - FILE_LABEL_ROOM)
    d = { el, k: 1, hidden: 0, offset: 0, shown: false }
    this.diffEls.set(n.file!, d)
    return d
  }

  /**
   * Builds every changed file's diff in idle time after a load, biggest boxes first, so zooming in to where the
   * text appears doesn't stall on building and laying out a screenful of diffs in one frame.
   */
  private prebuildDiffs() {
    const generation = this.buildGeneration
    const queue = this.fileNodes
      .filter((n) => this.a.files[n.file!].hunks?.length)
      .sort((x, y) => y.w * y.h - x.w * x.h)
    const step = (deadline: { timeRemaining(): number }) => {
      if (generation !== this.buildGeneration) return
      while (queue.length && deadline.timeRemaining() > 2) this.diffFor(queue.shift()!)
      if (queue.length) idle(step)
    }
    idle(step)
  }

  /** The selected file, if the pointer is over its text (the part of its box on screen, below its label). */
  private diffUnderPointer(e: WheelEvent): number | null {
    const n = this.selected
    if (!n || n.kind !== 'file') return null
    const d = this.diffEls.get(n.file!)
    if (!d || !d.shown || Number(d.el.style.opacity) < 0.5) return null
    const r = d.el.getBoundingClientRect()
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom ? n.file! : null
  }

  /**
   * A wheel over the selected file's text scrolls its diff and never moves the map (a pinch still zooms it). Its
   * text wraps to the window's edge (see drawDiffs), so there's nothing to scroll sideways.
   */
  private scrollDiff(e: WheelEvent, dy: number): boolean {
    // A scroll gesture goes to one place, decided when it starts: the file's text if the pointer is over it then,
    // otherwise the map. So panning across the file doesn't turn into scrolling it, and a scroll that started on
    // the file doesn't spill into the map as momentum carries on (macOS scroll views work the same way).
    const fresh = e.timeStamp - this.wheelGesture.last > WHEEL_GESTURE_GAP_MS
    this.wheelGesture.last = e.timeStamp
    if (fresh) this.wheelGesture.file = this.diffUnderPointer(e)
    const file = this.wheelGesture.file
    if (file === null || !this.selected || this.selected.file !== file) return false
    const d = this.diffEls.get(file)
    if (!d) return false
    // Over the selected file, up and down belong to the file: it scrolls the diff (lines wrap, so only that way),
    // and at the top or bottom it stops there rather than carrying on into the map.
    const el = d.el
    el.scrollTop += dy / d.k
    d.offset = el.scrollTop - d.hidden // the browser stops it at either end
    return true
  }

  private level(vb: View): { level: Level; trail: MapNode[] } {
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
    if (last.kind === 'file') level = this.textScale() >= DIFF_TEXT_FULL ? 'Diff' : 'File'
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

/**
 * The files on the changed-files view: the ones the branch changes (with tests and translations only if they're
 * shown). One exception: the unchanged file a forbidden import reaches into, so a violation's arrow has its target.
 * (`importers` is kept for the call's shape; importers show only with Unchanged files on.)
 */
export function touched(a: Analysis, _importers: boolean, hide: ReadonlySet<FileRole>): Set<number> {
  const out = new Set<number>()
  a.files.forEach((f, i) => { if (f.status !== 'unchanged' && !hide.has(roleOf(f))) out.add(i) })
  const forbidden = new Set(
    a.findings.filter((f) => f.kind === 'forbidden-dependency' || f.kind === 'deepens-violation').map((f) => `${f.target!.edge!.from}>${f.target!.edge!.to}`),
  )
  for (const e of a.edges) {
    if (e.state !== 'added' || !out.has(e.from)) continue
    if (forbidden.has(`${a.files[e.from].module}>${a.files[e.to].module}`)) out.add(e.to)
  }
  return out
}

function hslToHex(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
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
