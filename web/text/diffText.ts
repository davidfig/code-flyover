// The main thread's side of the diff text: asks the layout worker for each file's text at the width its box wraps
// at, uploads what comes back to the GPU, and draws it. Uploads happen as results arrive; drawing is uniforms only.
// A file far from the view gives its GPU buffers back, and is laid out again when it comes near.

import type { FileInfo } from '../../shared/types.ts'
import { loadFace, TextBlock, TextRenderer, type FaceMetrics, type GpuFace, type Placement } from '../gl/text.ts'
import type { ButtonHit, GapAction, Laid } from './layout.ts'
import type { ToWorker } from './worker.ts'
import type { Settings } from '../settings.ts'

/** One file's text: on the GPU once laid out. */
export interface FileText {
  block: TextBlock | null
  /** the laid-out content's height and the width it wraps at, text px (0 until laid out) */
  height: number
  width: number
  buttons: ButtonHit[]
  /** the width last asked for, and the request's number (a newer request makes older results stale) */
  asked: number
  seq: number
  /** a box to fill: the height it was last asked to fill to */
  fillTo: number
}

/** Running counts for the frame-timing readout. */
export interface TextStats {
  /** layouts that arrived from the worker, bytes uploaded to the GPU, and how long the uploads took (ms) */
  uploads: number
  uploadBytes: number
  uploadMs: number
  /** layouts asked for and not back yet */
  pending: number
  /** glyphs and files drawn in the last frame */
  glyphs: number
  files: number
  /** the cached picture of small text (see map.ts buildCache): rebuilds so far, the last one's time (ms), drawn from it last frame */
  cacheBuilds: number
  cacheMs: number
  cacheUsed: boolean
}

export class DiffText {
  readonly stats: TextStats = { uploads: 0, uploadBytes: 0, uploadMs: 0, pending: 0, glyphs: 0, files: 0, cacheBuilds: 0, cacheMs: 0, cacheUsed: false }
  private worker: Worker
  private face: GpuFace | null = null
  private renderer: TextRenderer
  private texts = new Map<number, FileText>()
  private seq = 0
  ready: Promise<void>

  constructor(private readonly gl: WebGL2RenderingContext, private readonly onChange: () => void) {
    this.renderer = new TextRenderer(gl)
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<{ type: 'laid'; id: number; seq: number } & Laid>) => this.received(e.data)
    this.ready = loadFace(gl, '/fonts/liberation-mono/regular', onChange).then(({ face, metrics }) => {
      this.face = face
      this.post({ type: 'init', metrics: metrics as FaceMetrics })
    })
  }

  private post(msg: ToWorker) {
    this.worker.postMessage(msg)
  }

  /** The settings text layout depends on (settings.ts): sent before the files, which lay out with them. */
  setSettings(values: Settings) {
    this.post({ type: 'settings', values })
  }

  /** The analysis' files with diffs, by index into analysis.files. Forgets everything laid out before. */
  setFiles(files: { id: number; file: FileInfo }[]) {
    for (const t of this.texts.values()) t.block?.dispose()
    this.texts.clear()
    this.post({ type: 'files', files })
  }

  get(id: number): FileText | undefined {
    return this.texts.get(id)
  }

  /**
   * Makes sure file `id` is laid out at `width` (and, the first time, filled to `fillTo`): asks the worker if not.
   * Results arrive later; until then the last layout (if any) keeps drawing.
   */
  want(id: number, width: number, fillTo = 0) {
    let t = this.texts.get(id)
    if (!t) {
      t = { block: null, height: 0, width: 0, buttons: [], asked: 0, seq: 0, fillTo }
      this.texts.set(id, t)
    }
    if (Math.abs(t.asked - width) < 0.5 && t.seq) return
    t.asked = width
    t.seq = ++this.seq
    this.stats.pending++
    this.post({ type: 'layout', id, width, fillTo: t.fillTo || undefined, seq: t.seq })
  }

  /** A gap bar's button was clicked. */
  expand(id: number, gap: number, action: GapAction) {
    const t = this.texts.get(id)
    if (!t) return
    t.seq = ++this.seq
    t.fillTo = 0 // from now on it's what the reader chose
    this.stats.pending++
    this.post({ type: 'expand', id, gap, action, width: t.asked, seq: t.seq })
  }

  /** Gives a file's GPU buffers back (it's far from the view); it's laid out again when wanted. */
  drop(id: number) {
    const t = this.texts.get(id)
    if (!t?.block) return
    t.block.dispose()
    t.block = null
    t.asked = 0
    t.seq = 0
  }

  ids(): IterableIterator<number> {
    return this.texts.keys()
  }

  private received(r: { id: number; seq: number } & Laid) {
    this.stats.pending = Math.max(0, this.stats.pending - 1)
    const t = this.texts.get(r.id)
    if (!t || r.seq !== t.seq) return // stale: a newer request is on its way
    const start = performance.now()
    t.block ??= new TextBlock(this.gl)
    t.block.upload(r.glyphs, r.glyphCount, r.rects, r.rectCount)
    this.stats.uploads++
    this.stats.uploadBytes += (r.glyphCount + r.rectCount) * 20
    this.stats.uploadMs += performance.now() - start
    t.height = r.height
    t.width = r.width
    t.buttons = r.buttons
    this.onChange()
  }

  draw(blocks: { id: number; at: Placement }[], viewport: { width: number; height: number }) {
    if (!this.face) return
    const list: { block: TextBlock; at: Placement }[] = []
    let glyphs = 0
    for (const b of blocks) {
      const t = this.texts.get(b.id)
      if (!t?.block) continue
      list.push({ block: t.block, at: b.at })
      glyphs += t.block.glyphs
    }
    this.stats.glyphs = glyphs
    this.stats.files = list.length
    this.renderer.render(this.face, list, viewport)
  }
}
