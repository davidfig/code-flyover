// The frame-timing readout (Show › Frame timing): where a frame's time goes, to find dropped frames.
//
// Frames are only drawn while something moves, so the numbers cover the last second of drawing: frames per second,
// the longest gap between frames (a dropped frame shows as one over ~17 ms), our script's time per frame, the GPU's
// time per frame where the browser has a GPU timer (EXT_disjoint_timer_query_webgl2), what was drawn, and what the
// worker sent and the main thread uploaded to the GPU.

import type { TextStats } from './text/diffText.ts'

interface Ext {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

const WINDOW_MS = 1000
const IDLE_MS = 250

export class FrameTiming {
  private el: HTMLElement
  private on = false
  private frames: { at: number; gap: number; script: number }[] = []
  private gpu: number[] = []
  private lastAt = 0
  private start = 0
  private ext: Ext | null
  private queries: WebGLQuery[] = []
  private active: WebGLQuery | null = null
  private shownAt = 0
  private uploadsAt = { n: 0, bytes: 0, ms: 0, t: 0 }
  private uploadRate = { n: 0, mb: 0, ms: 0 }

  constructor(host: HTMLElement, private readonly gl: WebGL2RenderingContext, private readonly text: () => TextStats) {
    this.el = document.createElement('div')
    this.el.className = 'perf'
    this.el.hidden = true
    host.appendChild(this.el)
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as Ext | null
  }

  set enabled(on: boolean) {
    this.on = on
    this.el.hidden = !on
    this.frames = []
    this.gpu = []
    this.lastAt = 0
  }

  get enabled() {
    return this.on
  }

  /** Call at the start of a frame (rAF time) and before its first draw. */
  begin(now: number) {
    if (!this.on) return
    this.start = performance.now()
    // A gap over IDLE_MS is the map resting between movements, not a dropped frame.
    const raw = this.lastAt ? now - this.lastAt : 0
    const gap = raw > IDLE_MS ? 0 : raw
    this.lastAt = now
    this.frames.push({ at: now, gap, script: 0 })
    this.pollGpu()
    if (this.ext && !this.active) {
      const q = this.gl.createQuery()
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
      this.active = q
    }
  }

  /** Call when the frame's drawing is done. */
  end(now: number) {
    if (!this.on) return
    const f = this.frames[this.frames.length - 1]
    if (f) f.script = performance.now() - this.start
    if (this.ext && this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
      this.queries.push(this.active)
      this.active = null
    }
    while (this.frames.length && this.frames[0].at < now - WINDOW_MS) this.frames.shift()
    if (now - this.shownAt > 250) {
      this.shownAt = now
      this.show(now)
    }
  }

  private pollGpu() {
    if (!this.ext) return
    const gl = this.gl
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean
    while (this.queries.length) {
      const q = this.queries[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number
      if (!disjoint) this.gpu.push(ns / 1e6)
      gl.deleteQuery(q)
      this.queries.shift()
    }
    if (this.gpu.length > 60) this.gpu.splice(0, this.gpu.length - 60)
  }

  private show(now: number) {
    const t = this.text()
    if (now - this.uploadsAt.t >= 1000) {
      this.uploadRate = { n: t.uploads - this.uploadsAt.n, mb: (t.uploadBytes - this.uploadsAt.bytes) / 1e6, ms: t.uploadMs - this.uploadsAt.ms }
      this.uploadsAt = { n: t.uploads, bytes: t.uploadBytes, ms: t.uploadMs, t: now }
    }
    const f = this.frames.filter((x) => x.gap > 0)
    const fps = this.frames.length
    const worst = f.length ? Math.max(...f.map((x) => x.gap)) : 0
    const dropped = f.filter((x) => x.gap > 20).length
    const script = this.frames.length ? this.frames.reduce((s, x) => s + x.script, 0) / this.frames.length : 0
    const scriptMax = this.frames.length ? Math.max(...this.frames.map((x) => x.script)) : 0
    const gpu = this.gpu.length ? this.gpu.reduce((s, x) => s + x, 0) / this.gpu.length : null
    const gpuMax = this.gpu.length ? Math.max(...this.gpu) : null
    const rows: [string, string, boolean?][] = [
      ['frames', fps ? `${fps}/s, worst ${worst.toFixed(0)} ms, ${dropped} dropped` : 'idle', dropped > 0],
      ['script', `${script.toFixed(1)} ms avg, ${scriptMax.toFixed(1)} max`, scriptMax > 12],
      ['gpu', gpu === null ? (this.ext ? 'measuring…' : 'no timer in this browser') : `${gpu.toFixed(1)} ms avg, ${gpuMax!.toFixed(1)} max`, (gpuMax ?? 0) > 12],
      ['drawn', `${t.glyphs.toLocaleString()} glyphs in ${t.files} files${t.cacheUsed ? ' + cached picture' : ''}`],
      ['cache', `${t.cacheBuilds} rebuilds, last ${t.cacheMs.toFixed(1)} ms (CPU side)`, t.cacheMs > 30],
      ['uploads', `${this.uploadRate.n}/s, ${this.uploadRate.mb.toFixed(1)} MB/s, ${this.uploadRate.ms.toFixed(1)} ms/s`, this.uploadRate.ms > 8],
      ['layouts', `${t.pending} waiting in the worker`],
    ]
    this.el.innerHTML = rows.map(([k, v, bad]) => `<div${bad ? ' class="bad"' : ''}><b>${k}</b> ${v}</div>`).join('')
  }
}
