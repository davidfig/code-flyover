// The zoomable map. WebGL draws the boxes (a retained rectangle layer) on one canvas, under the diffs, and the
// arrows and outlines (immediate triangles) on a second, transparent canvas above them, so an arrow into a file
// you're reading isn't hidden by its text. DOM layers draw the text: labels stay a fixed screen size, diffs scale
// with their box.
// No rendering or camera library: see web/gl/.

import type { Analysis, ChangeSet, FileEdge, FileInfo, FileRole } from '../shared/types.ts'
import { buildMap, COL_W, roleOf, type MapNode } from './layout.ts'
import { Camera, type Rect } from './gl/camera.ts'
import { attachInput } from './gl/input.ts'
import { rgba } from './gl/program.ts'
import { RectLayer } from './gl/rects.ts'
import { Shapes } from './gl/shapes.ts'
import { DiffText } from './text/diffText.ts'
import { FrameTiming } from './perf.ts'
import { TextCache } from './gl/textCache.ts'
import type { Placement } from './gl/text.ts'

/** A node opens (shows its children) once it is this many pixels on its short side. */
const OPEN_PX = 170
/**
 * Diff text is the same size in every file at a given zoom, as on a map: zooming makes all of it bigger
 * together, and a bigger box shows more of its file rather than bigger letters. The size is a scale of the
 * 12px text the CSS sets: 1 when a file of the median width is DIFF_W px wide on screen.
 */
const DIFF_W = COL_W // text at its normal size when a file column is its laid-out width (100 characters of code)
/**
 * Diff text is drawn at every zoom, however small (it's what the boxes are made of). Between these scales (about 3px
 * to 7px text) it becomes readable: headings fade out, the selected file's label gives way to the header, and clicks
 * go to the text (see readable).
 */
const DIFF_TEXT_FROM = 0.25
const DIFF_TEXT_FULL = 0.55
/** Glyphs drawn into the cached picture being built per frame (see buildSlice): about 2 ms of GPU time. */
const CACHE_GLYPHS_PER_FRAME = 300_000
/** While new text keeps arriving, the cached picture is redrawn at most this often. */
const CACHE_REBUILD_MS = 400
/** The deepest zoom: text at this many times its normal size (it scales with its box, so it never re-wraps). */
const TEXT_MAX_SCALE = 3
/** Labels fade in between these widths, instead of popping. */
const LABEL_FROM_PX = 40
const LABEL_FULL_PX = 72
/** Wheel events further apart than this start a new gesture (as in gl/input.ts). */
const WHEEL_GESTURE_GAP_MS = 200
/** A heading tag whose box is less than this much on screen stays when diff text shows: it says where you are. */
const HEADING_KEEP_VISIBLE = 0.5
/** A tag's padding and border (style.css .label): horizontal and vertical, CSS px. */
const TAG_PAD_X = 10
const TAG_PAD_Y = 4
/** The selected box's outline, in CSS px. */
const SELECT_PX = 3
/** How long the camera takes to fly to something. */
const FLY_MS = 650

export type Level = 'System' | 'Module' | 'Folder' | 'File' | 'Diff'

export interface MapOptions {
  showImpacted: boolean
  dimUnchanged: boolean
  /** tests (unit and e2e) on the map */
  showTests: boolean
  /** translation files on the map */
  showLocales: boolean
  /** files the branch doesn't touch on the map */
  showUnchanged: boolean
  /** the frame-timing readout (see perf.ts) */
  showTiming: boolean
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

/** A file's text on screen this frame (drawn on the GPU, see text/diffText.ts): its scroll, and where it went. */
interface TextState {
  /** text scale: device-independent px per text px */
  k: number
  /** how much of the box's text area is above the window, text px */
  hidden: number
  /** how far the reader has scrolled it, on top of what moving the box does, text px */
  offset: number
  /** the visible text area's height, text px */
  visH: number
  /** where it was drawn: the visible text area, and where text px (0, 0) is, in CSS px on the map (null: not drawn) */
  clip: { x: number; y: number; w: number; h: number } | null
  originX: number
  originY: number
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
  // Box fills that match the diff text's row colours (see text/layout.ts): added, removed, unchanged lines.
  addedFill: 0xd3ecd9,
  removedFill: 0xf6d3d7,
  contextFill: 0xf6f4ee,
  deletedBorder: 0xe39aa3,
  impactedFill: 0xd9e6f3,
  edgeAdded: 0xd9822b,
  edgeViolation: 0xc8414f,
  edgeRemoved: 0x7a6fb0,
  // A selected file's neighbours, outlined (see drawSelection; style.css .sw.imports/.importers match).
  imports: 0x1a9a8a,
  importers: 0x8a5cc8,
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
  opts: MapOptions = { showImpacted: true, dimUnchanged: false, showTests: false, showLocales: false, showUnchanged: false, showTiming: false }
  selected: MapNode | null = null
  /** the selected file's neighbours on the map (see linksOf) */
  private linked: { imports: MapNode[]; importers: MapNode[] } = { imports: [], importers: [] }
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
  private labelPool: HTMLElement[] = []
  private changesLayer: HTMLElement
  private cards: ChangeCard[] = []
  /** whether placeCards has run for this layout and whole-map zoom */
  private cardsPlaced = false
  /** the scale that fits the whole map; change cards show near it and fade as you zoom in */
  private fitScale = 1
  /** looking at something (a change, a finding): the cards step aside until Esc or Whole map */
  private zoomed = false
  /** the diff text, on the GPU, laid out by a worker */
  private text!: DiffText
  private timing!: FrameTiming
  /** a picture of all the small diff text, drawn once per zoom level (see textCache.ts) */
  private cache!: TextCache
  /** a frame booked for when the cache throttle allows a rebuild */
  private cacheTimer: ReturnType<typeof setTimeout> | null = null
  /** each file's node, by index into analysis.files */
  private nodeByFile = new Map<number, MapNode>()
  /** each file's text on screen, by file index */
  private textStates = new Map<number, TextState>()
  /** bumped on every load, so a pre-fetch still running for the last analysis stops */
  private buildGeneration = 0
  /** median file width in world units: what the diff text size is measured against */
  private medianFileW = 1
  private pending = false
  private lastFrame = 0
  private lastLevel = ''
  /** the current wheel gesture: when its last event came, and the file it's scrolling (null: the map) */
  private wheelGesture = { last: -Infinity, file: null as number | null }
  private userMoved = false

  constructor(private host: HTMLElement, private events: MapEvents) {
    this.labels = document.createElement('div')
    this.labels.className = 'labels'
    this.changesLayer = document.createElement('div')
    this.changesLayer.className = 'changes'
  }

  async init() {
    const gl = this.canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false })
    if (!gl) throw new Error('WebGL 2 is not available')
    this.gl = gl
    this.rects = new RectLayer(gl)
    // New text from the worker: the cached picture is out of date (redrawn, throttled, on the next frames).
    this.text = new DiffText(gl, () => {
      this.cache.dirty = true
      this.schedule()
    })
    this.timing = new FrameTiming(this.host, gl, () => this.text.stats)
    this.cache = new TextCache(gl)
    const overlayGl = this.overlay.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: true })
    if (!overlayGl) throw new Error('WebGL 2 is not available')
    this.overlayGl = overlayGl
    this.shapes = new Shapes(overlayGl)
    this.overlay.className = 'overlay'
    this.host.appendChild(this.canvas)
    this.host.appendChild(this.overlay)
    this.host.appendChild(this.labels)
    this.host.appendChild(this.changesLayer)
    attachInput(this.host, this.camera, {
      changed: () => {
        this.userMoved = true
        this.schedule()
      },
      click: (x, y, double) => {
        if (!double && this.clickText(x, y)) return // a gap bar's button in the selected file's text
        const w = this.camera.toWorld(x, y)
        const n = this.hit(w.x, w.y)
        if (double && n) {
          // A double-click reads the box (and keeps it selected, though its first click may have just unselected it).
          this.select(n)
          this.readBox(n)
        } else if (n && n === this.selected) this.clearSelection() // clicking the selected box again unselects it
        else this.select(n)
      },
      wheel: (e, x, y, _dx, dy) => this.scrollText(e, x, y, dy),
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
      this.frame() // straight away: the resize wiped the canvas (and before a branch loads, it clears it to the background)
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
    // The column layout takes the map's shape.
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
    this.linked = { imports: [], importers: [] }
    this.highlight = []
    this.highlightEdge = null
    this.focus = false
    this.textStates.clear()
    this.cache.reset()
    this.nodeByFile = new Map(this.fileNodes.map((n) => [n.file!, n]))
    this.buildGeneration++
    const widths = this.fileNodes.map((n) => n.w).sort((x, y) => x - y)
    // In the column view boxes widen to fill space, but the text shouldn't grow with them: measure it against the
    // column width. In the treemap, against the median file.
    this.medianFileW = this.opts.showUnchanged ? (widths[Math.floor(widths.length / 2)] ?? 1) : COL_W
    // Text scales with its box at every zoom (so a line always wraps at the same place); the deepest zoom stops it
    // at TEXT_MAX_SCALE times its normal size.
    this.camera.maxScale = (TEXT_MAX_SCALE * DIFF_W) / this.medianFileW
    this.text.setFiles(this.fileNodes.filter((n) => a.files[n.file!].hunks?.length).map((n) => ({ id: n.file!, file: a.files[n.file!] })))
    this.prefetchText()
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

  /** New change descriptions (written from the side panel): rebuild the cards without touching the view. */
  setChanges(cs: ChangeSet | undefined) {
    this.a.changes = cs
    this.buildCards()
    this.cardsPlaced = false
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
    this.timing.enabled = this.opts.showTiming
    // Showing or hiding files changes the layout.
    if (relayout && this.a) return this.load(this.a)
    this.drawBoxes()
    this.schedule()
  }

  fitAll(animate = true) {
    if (animate) this.userMoved = false
    this.zoomed = false
    const r = { x: this.root.x, y: this.root.y, w: this.root.w, h: this.root.h }
    // The fit is clamped to the camera's limits, and the zoom-out limit is the previous fit's: for a bigger map (another
    // branch, more files shown) it would stop short of the whole map. Lift it first.
    this.camera.minScale = 0
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
    const st = n.file !== undefined ? this.textStates.get(n.file) : undefined
    if (st) st.offset = 0
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
    this.linked = this.linksOf(n)
    this.events.onSelect(n)
    this.schedule()
  }

  /** The boxes a selected file imports, and those that import it (not imports the branch removed). */
  private linksOf(n: MapNode | null): { imports: MapNode[]; importers: MapNode[] } {
    const out = { imports: [] as MapNode[], importers: [] as MapNode[] }
    if (!n || n.kind !== 'file') return out
    for (const e of this.a.edges) {
      if (e.state === 'removed') continue
      const other = e.from === n.file ? e.to : e.to === n.file ? e.from : -1
      const node = other >= 0 && other !== n.file ? this.nodeByFile.get(other) : undefined
      if (node) (e.from === n.file ? out.imports : out.importers).push(node)
    }
    return out
  }

  /** The side panel's import list: select a file and fly to it. */
  goToFile(file: number) {
    const n = this.nodeByFile.get(file)
    if (!n) return
    this.zoomTo([n])
    this.select(n)
  }

  /** Whether a file is on the map (hidden ones, like tests with Tests off, have no box). */
  hasFile(file: number) {
    return this.nodeByFile.has(file)
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
      if (this.opts.showImpacted && this.impacted.has(n.file!)) { color = C.impactedFill; alpha = 1 }
      if (info.status !== 'unchanged' && roleOf(info) !== 'source') {
        // Tests, translations, generated files: no tint (a faint one still reads as "modified" from far out).
        r.add(n.x, n.y, n.w, n.h, rgba(info.test ? C.fileTest : C.file, dim ? 0.35 : 1))
        continue
      }
      // Coloured like their diff looks when its text fades in: the light green of added rows, the light pink of
      // removed ones, and for a modified file a mix of those and the near-white of unchanged lines, in proportion.
      if (info.status === 'added') { color = C.addedFill; alpha = 1 }
      else if (info.status === 'modified' || info.status === 'renamed') {
        color = diffTint(info)
        alpha = 1
      } else if (info.status === 'deleted') {
        r.addBox(n.x, n.y, n.w, n.h, rgba(C.removedFill), rgba(C.deletedBorder), dpr)
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
      this.timing.begin(now)
      this.frame()
      this.timing.end(now)
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
    // The canvas is opaque: until something is drawn it shows black. So it's cleared to the map's background even
    // before a branch has loaded (the first frames, while its analysis is still arriving).
    if (!this.a) {
      const gl = this.gl
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.clearColor(((C.bg >> 16) & 255) / 255, ((C.bg >> 8) & 255) / 255, (C.bg & 255) / 255, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      return
    }
    const cam = this.camera
    const v = cam.view
    const vb: View = { x: v.x, y: v.y, width: v.w, height: v.h }
    const s = cam.scale
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(((C.bg >> 16) & 255) / 255, ((C.bg >> 8) & 255) / 255, (C.bg & 255) / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.rects.render(cam)
    const { level, trail } = this.level(vb)
    const path = new Set(trail)
    this.drawText(vb, s, path)
    const og = this.overlayGl
    og.viewport(0, 0, this.overlay.width, this.overlay.height)
    og.clearColor(0, 0, 0, 0)
    og.clear(og.COLOR_BUFFER_BIT)
    this.drawEdges()
    this.drawSelection()
    this.shapes.flush(this.overlay.width, this.overlay.height)
    this.drawLabels(vb, s, path)
    this.drawCards(vb, s)
    const key = level + trail.map((n) => n.id).join(',')
    if (key !== this.lastLevel) {
      this.lastLevel = key
      this.events.onView(level, trail)
    }
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
    return null
  }

  private drawEdges() {
    const agg = new Map<string, { a: MapNode; b: MapNode; kind: string; n: number }>()
    // Arrows only where they say something a list can't: a forbidden import (always; it's rare and the architecture
    // problem you most want to spot), and the edge of the finding being looked at. A selected file's imports are
    // outlined instead (see drawSelection) and listed in the side panel.
    const under = (file: number, n: MapNode) => this.ancestors[file].includes(n)
    const he = this.highlightEdge
    const focusing = this.focus && this.highlight.length > 0
    const wanted = (e: FileEdge, kind: string | null) => {
      if (kind === 'violation') return true
      if (he && this.a.files[e.from].module === he.from && this.a.files[e.to].module === he.to) return true
      return focusing && this.highlight.some((h) => under(e.from, h)) && this.highlight.some((h) => under(e.to, h))
    }
    for (const e of this.a.edges) {
      if (!this.ancestors[e.from] || !this.ancestors[e.to]) continue // a hidden file
      const kind = this.edgeKind(e)
      if (!kind || !wanted(e, kind)) continue
      const a = this.rep(e.from)
      const b = this.rep(e.to)
      if (a === b) continue
      const key = `${a.id}>${b.id}>${kind}`
      const cur = agg.get(key)
      if (cur) cur.n++
      else agg.set(key, { a, b, kind, n: 1 })
    }
    const order = { removed: 1, added: 2, violation: 3 } as Record<string, number>
    const list = [...agg.values()].sort((x, y) => order[x.kind] - order[y.kind])
    const within = (n: MapNode) => this.highlight.some((h) => { for (let c: MapNode | null = n; c; c = c.parent) if (c === h) return true; return false })
    for (const { a, b, kind, n } of list) {
      const color = kind === 'violation' ? C.edgeViolation : kind === 'added' ? C.edgeAdded : C.edgeRemoved
      const emph = (he && a.module === he.from && b.module === he.to) || (focusing && within(a) && within(b))
      const px = (1.6 + Math.min(3, Math.log2(n))) * (emph ? 1.8 : 1)
      const alpha = emph || (!he && !focusing) ? 0.9 : 0.25
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
    // A selected file's neighbours: what it imports and what imports it, outlined rather than joined by arrows, so
    // they read at any zoom. (A fill would sit over their text: the outlines are on the layer above it.)
    for (const n of this.linked.imports) box(n, 2.5, rgba(C.imports, 0.9))
    for (const n of this.linked.importers) box(n, 2.5, rgba(C.importers, 0.9))
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
    const textShowing = this.readable()
    const textOpacity = smoothstep(DIFF_TEXT_FROM, DIFF_TEXT_FULL, this.textScale())
    type Box = { x0: number; y0: number; x1: number; y1: number }
    const sel = this.selected?.kind === 'file' ? this.selected : null
    const selBox: Box = sel
      ? { x0: (sel.x - vb.x) * s, y0: (sel.y - vb.y) * s, x1: (sel.x + sel.w - vb.x) * s, y1: (sel.y + sel.h - vb.y) * s }
      : { x0: 0, y0: 0, x1: 0, y1: 0 }
    /** Draws n's label below any ancestor label it would land on; returns where it went (null: not drawn). */
    const put = (n: MapNode, above: Box[]): Box | null => {
      const { w, h } = this.screenSize(n)
      if (w < LABEL_FROM_PX || h < 14) return null
      // A box whose top has gone above the window would get its label pinned to the window's top edge, floating
      // over the text. On the breadcrumb path the header names it; and once diff text is showing, no label floats.
      if (n.y < vb.y && (inHeader.has(n) || textShowing)) return null
      // The selected file, when its text shows, is named in the header: no label line over it.
      if (this.reading(n)) return null
      // A tag at the box's top-left corner, sliding along the window's edge when that corner is off screen.
      const sx = Math.max((n.x - vb.x) * s, 0) + 3
      let sy = Math.max((n.y - vb.y) * s, 0) + 3
      const lineH = (n.kind === 'module' ? 19 : 14) + TAG_PAD_Y
      // Headings fade out as diff text becomes readable (the tags would sit over it, and the header names where you
      // are), except one whose box is mostly off screen: then its tag is the only sign of which box you're in.
      let fade = 1
      if (n.kind !== 'file' && textOpacity > 0) {
        const vw = Math.min(n.x + n.w, vb.x + vb.width) - Math.max(n.x, vb.x)
        const vh = Math.min(n.y + n.h, vb.y + vb.height) - Math.max(n.y, vb.y)
        const shown = (Math.max(0, vw) * Math.max(0, vh)) / (n.w * n.h)
        if (shown >= HEADING_KEEP_VISIBLE) fade = 1 - textOpacity
        if (fade <= 0.02) return null
      }
      // Only the part of the box that's on screen is the label's to use: when the box runs off the left edge the label
      // is pulled in to the window's edge, and must still stop at the box's right side, not spill into the next box.
      const boxRight = (n.x + n.w - vb.x) * s
      const avail = boxRight - sx - 3 - TAG_PAD_X
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
      // Nested boxes' corners nearly meet when zoomed out, so a tag can land on an ancestor's: then it moves down
      // just below it, if the box still has room for it.
      const right = sx + Math.min(taken, avail) + TAG_PAD_X
      for (const b of above) if (sx < b.x1 && right > b.x0 && sy < b.y1 && sy + lineH > b.y0) sy = b.y1 + 2
      const boxBottom = (n.y - vb.y) * s + h
      // A selected file is what you're looking at: no other box's tag sits over it (its folders' tags would land on
      // its corner, since nested corners nearly meet).
      const over =
        sel !== null && n !== sel && sx < selBox.x1 && right > selBox.x0 && sy < selBox.y1 && sy + lineH > selBox.y0
      if (sy + lineH > boxBottom || over) {
        used--
        setStyle(el, 'display', 'none')
        return null
      }
      if (el.dataset.html !== html) {
        el.innerHTML = html
        el.dataset.html = html
      }
      setStyle(el, 'transform', `translate(${px(sx)}, ${px(sy)})`)
      setStyle(el, 'maxWidth', px(avail)) // content width: the padding is outside it
      setStyle(el, 'opacity', (fade * smoothstep(LABEL_FROM_PX, LABEL_FULL_PX, Math.min(w, h * 3))).toFixed(2))
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

  /** Whether the diff text is big enough to read at this zoom (see DIFF_TEXT_FROM). */
  private readable(): boolean {
    return this.textScale() >= DIFF_TEXT_FROM
  }

  /** The diff text's scale at the current zoom (see DIFF_W). */
  private textScale(): number {
    return (this.camera.scale * this.medianFileW) / DIFF_W
  }

  /**
   * The file being read: the selected one, with its text showing. The header names it, so it has no label. (Not the
   * file at the centre of the view: as you pan, files passing under the centre would lose their labels.)
   */
  private reading(n: MapNode): boolean {
    return n.kind === 'file' && this.selected === n && this.readable()
  }

  /**
   * The diff text: one size for the zoom (textScale), drawn on the GPU in each file's box, clipped to the part of the
   * box that's on screen, at every zoom.
   *
   * Windowing: unscrolled, the text moves with its box as if nothing were cut off; scrolled, any line can reach the
   * visible part (the first down to its top, the last up to its bottom). The selected file also wraps at the
   * window's edge; others wrap to their box, so they don't rewrap as you pan past them.
   */
  private drawText(vb: View, s: number, _path: Set<MapNode>) {
    const k = this.textScale()
    for (const st of this.textStates.values()) st.clip = null
    const dpr = this.camera.dpr
    const W = this.camera.width
    const H = this.camera.height
    const viewport = { width: this.canvas.width, height: this.canvas.height }

    // Which files show text at this zoom (ignoring what's on screen): the cache must hold exactly these.
    const shows = (n: MapNode) => {
      if (!this.a.files[n.file!].hunks?.length) return false
      const { w, h } = this.screenSize(n)
      return w >= 2 && h >= 2 // however small its box: below a couple of pixels there's nothing to see
    }

    // Draw from a cached picture of all the text while it fits in a texture (see textCache.ts). The selected file and
    // any file you've scrolled move on their own, so they're drawn live on top.
    const live = (n: MapNode) => this.selected === n || (this.textStates.get(n.file!)?.offset ?? 0) !== 0
    let cached = false
    this.text.stats.cacheUsed = false
    const level = 2 ** Math.ceil(Math.log2(s * dpr)) // device px per world unit, rounded up to a power of two
    const tw = Math.ceil(this.root.w * level)
    const th = Math.ceil(this.root.h * level)
    if (tw <= this.cache.maxSize && th <= this.cache.maxSize) {
      const c = this.cache
      const ids = this.fileNodes.filter((n) => shows(n) && !live(n)).map((n) => n.file!)
      const key = ids.join(',')
      const frontOk = c.front?.level === level && c.front.key === key
      const building = c.build?.level === level && c.build.key === key
      const since = performance.now() - c.builtAt
      if (!frontOk && !building) c.start(tw, th, level, key, ids)
      else if (frontOk && c.dirty && !c.build) {
        if (since > CACHE_REBUILD_MS) c.start(tw, th, level, key, ids)
        // Held back by the throttle: come back when it allows, or the picture stays stale until something moves.
        else if (!this.cacheTimer) {
          this.cacheTimer = setTimeout(() => {
            this.cacheTimer = null
            this.schedule()
          }, CACHE_REBUILD_MS - since + 1)
        }
      }
      if (c.build) {
        this.buildSlice(k)
        this.schedule() // keep building on the next frames, even if nothing moves
      }
      if (c.front) {
        // The front picture, even one for another zoom level or file set while its replacement is built.
        const sc = s * dpr
        c.draw((this.root.x - vb.x) * sc, (this.root.y - vb.y) * sc, this.root.w * sc, this.root.h * sc, 1, viewport)
        cached = true
        this.text.stats.cacheUsed = true
      }
    }

    const list: { id: number; at: Placement }[] = []
    for (const n of this.fileNodes) {
      if (!shows(n) || !this.visible(n, vb)) continue
      if (cached && !live(n)) continue
      const id = n.file!
      const { w, h } = this.screenSize(n)
      const sx = (n.x - vb.x) * s
      const sy = (n.y - vb.y) * s
      // Room for the file's label, as a share of the box, so the text never slides within its box as you zoom.
      const boxTop = sy // the file's tag floats over its text: no room is kept for it
      const visTop = Math.max(boxTop, 0)
      const visBottom = Math.min(sy + h, H)
      if (visBottom - visTop < 2) continue
      const selected = this.selected === n
      const visLeft = Math.max(sx, 0)
      const visRight = Math.min(sx + w, W)
      if (visRight - visLeft < 2) continue
      // Lay out at the width it wraps at: the box's, or for the selected file the visible part's.
      const wrap = selected ? (visRight - visLeft) / k : w / k
      this.text.want(id, wrap, (n.h * DIFF_W) / this.medianFileW)
      let st = this.textStates.get(id)
      if (!st) {
        st = { k, hidden: 0, offset: 0, visH: 0, clip: null, originX: 0, originY: 0 }
        this.textStates.set(id, st)
      }
      const contentH = this.text.get(id)?.height ?? 0
      st.k = k
      st.hidden = (visTop - boxTop) / k
      st.visH = (visBottom - visTop) / k
      const scroll = Math.max(0, Math.min(st.hidden + st.offset, Math.max(0, contentH - st.visH)))
      st.offset = scroll - st.hidden
      st.originX = selected ? visLeft : sx
      st.originY = visTop - scroll * k
      st.clip = { x: visLeft, y: visTop, w: visRight - visLeft, h: visBottom - visTop }
      list.push({
        id,
        at: { x: st.originX * dpr, y: st.originY * dpr, scale: k * dpr, alpha: 1, clip: { x: st.clip.x * dpr, y: st.clip.y * dpr, w: st.clip.w * dpr, h: st.clip.h * dpr } },
      })
    }
    this.text.draw(list, viewport)
  }

  /**
   * Draws the next slice of files into the picture being built, up to CACHE_GLYPHS_PER_FRAME glyphs, so no frame
   * redraws the whole map; when the last one is in, the picture goes on screen. A file not laid out yet is left out
   * (it's asked for; when it arrives the picture is marked dirty and rebuilt).
   */
  private buildSlice(k: number) {
    const c = this.cache
    const build = c.build
    if (!build) return
    const level = build.level
    const per = (level * this.medianFileW) / DIFF_W // device px per text px at this level
    const start = performance.now()
    const list: { id: number; at: Placement }[] = []
    let glyphs = 0
    while (build.queue.length && glyphs < CACHE_GLYPHS_PER_FRAME) {
      const id = build.queue.shift()!
      const n = this.nodeByFile.get(id)
      if (!n) continue
      this.text.want(id, (n.w * DIFF_W) / this.medianFileW, (n.h * DIFF_W) / this.medianFileW)
      const t = this.text.get(id)
      if (!t?.block) continue
      glyphs += t.block.glyphs
      const x = (n.x - this.root.x) * level
      const y = (n.y - this.root.y) * level
      list.push({ id, at: { x, y, scale: per, alpha: 1, clip: { x, y, w: n.w * level, h: n.h * level } } })
    }
    const size = c.bindBack()
    if (size) {
      this.text.draw(list, size)
      c.release(this.canvas.width, this.canvas.height)
    }
    if (!build.queue.length) {
      c.finish(performance.now())
      this.text.stats.cacheBuilds++
    }
    this.text.stats.cacheMs = performance.now() - start
  }

  /**
   * Lays out every changed file's text in the worker soon after a load, biggest boxes first, so it's on the GPU
   * before you zoom in to it.
   */
  private prefetchText() {
    const generation = this.buildGeneration
    const queue = this.fileNodes.filter((n) => this.a.files[n.file!].hunks?.length).sort((x, y) => y.w * y.h - x.w * x.h)
    const step = (deadline: { timeRemaining(): number }) => {
      if (generation !== this.buildGeneration) return
      while (queue.length && deadline.timeRemaining() > 1) {
        const n = queue.shift()!
        this.text.want(n.file!, (n.w * DIFF_W) / this.medianFileW, (n.h * DIFF_W) / this.medianFileW)
      }
      if (queue.length) idle(step)
    }
    idle(step)
  }

  /** The file whose text is at (x, y) CSS px on the map (the selected one only: the others' clicks select them). */
  private textAt(x: number, y: number): number | null {
    const n = this.selected
    if (!n || n.kind !== 'file') return null
    const st = this.textStates.get(n.file!)
    const c = st?.clip
    if (!c || !this.readable()) return null
    return x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h ? n.file! : null
  }

  /** A click on the selected file's text: one of its gap bar's buttons, if it hit one. */
  private clickText(x: number, y: number): boolean {
    const id = this.textAt(x, y)
    if (id === null) return false
    const st = this.textStates.get(id)!
    const t = this.text.get(id)
    if (!t) return false
    const tx = (x - st.originX) / st.k
    const ty = (y - st.originY) / st.k
    const b = t.buttons.find((b) => tx >= b.x0 && tx <= b.x1 && ty >= b.y0 && ty <= b.y1)
    if (!b) return false
    this.text.expand(id, b.gap, b.action)
    return true
  }

  /**
   * A wheel over the selected file's text scrolls it and never moves the map (a pinch still zooms it). Its text
   * wraps to the window's edge, so there's nothing to scroll sideways.
   */
  private scrollText(e: WheelEvent, x: number, y: number, dy: number): boolean {
    // A scroll gesture goes to one place, decided when it starts: the file's text if the pointer is over it then,
    // otherwise the map. So panning across the file doesn't turn into scrolling it, and a scroll that started on
    // the file doesn't spill into the map as momentum carries on (macOS scroll views work the same way).
    const fresh = e.timeStamp - this.wheelGesture.last > WHEEL_GESTURE_GAP_MS
    this.wheelGesture.last = e.timeStamp
    if (fresh) this.wheelGesture.file = this.textAt(x, y)
    const file = this.wheelGesture.file
    if (file === null || !this.selected || this.selected.file !== file) return false
    const st = this.textStates.get(file)
    if (!st) return false
    // Up and down belong to the file; at the top or bottom it stops there rather than carrying on into the map.
    const contentH = this.text.get(file)?.height ?? 0
    const scroll = Math.max(0, Math.min(st.hidden + st.offset + dy / st.k, Math.max(0, contentH - st.visH)))
    st.offset = scroll - st.hidden
    this.schedule()
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

/** A modified file's box: its diff's added, removed and unchanged lines blended, as its text averages out from afar. */
function diffTint(f: FileInfo): number {
  let add = 0, del = 0, ctx = 0
  for (const h of f.hunks ?? []) for (const l of h.lines) l.t === '+' ? add++ : l.t === '-' ? del++ : ctx++
  const total = add + del + ctx || 1
  const mix = (c: number, shift: number) => ((c >> shift) & 255)
  const channel = (shift: number) =>
    Math.round((mix(C.addedFill, shift) * add + mix(C.removedFill, shift) * del + mix(C.contextFill, shift) * ctx) / total)
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
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
