// Maps world space (the map's units, y down) to the canvas. Adapted from golemdocs' Camera
// (client/src/view/camera.ts): the same zoomAt / panBy / fit, measured in CSS px per world unit,
// plus an eased flight to a rectangle and coasting after a drag.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export class Camera {
  /** World point at the canvas's top-left corner. */
  x = 0
  y = 0
  /** CSS px per world unit. */
  scale = 1
  minScale = 0.05
  maxScale = 600
  /** Canvas size in CSS px, and device px per CSS px. */
  width = 1
  height = 1
  dpr = 1

  private flight: { from: { x: number; y: number; scale: number }; to: { x: number; y: number; scale: number }; start: number; ms: number } | null = null
  private velocity: { x: number; y: number } | null = null

  /** The part of the world in view. */
  get view(): Rect {
    return { x: this.x, y: this.y, w: this.width / this.scale, h: this.height / this.scale }
  }

  toWorld(cssX: number, cssY: number): { x: number; y: number } {
    return { x: this.x + cssX / this.scale, y: this.y + cssY / this.scale }
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.scale, y: (wy - this.y) * this.scale }
  }

  /** Zooms by `factor`, keeping the world point under (cssX, cssY) fixed on screen. */
  zoomAt(cssX: number, cssY: number, factor: number): void {
    this.stop()
    const before = this.toWorld(cssX, cssY)
    this.scale = Math.min(Math.max(this.scale * factor, this.minScale), this.maxScale)
    const after = this.toWorld(cssX, cssY)
    this.x += before.x - after.x
    this.y += before.y - after.y
  }

  /** Scrolls by a distance in CSS px. */
  panBy(cssDx: number, cssDy: number): void {
    this.stop()
    this.x += cssDx / this.scale
    this.y += cssDy / this.scale
  }

  /** The view that shows `r` filling `fill` of the canvas, centred. */
  fitted(r: Rect, fill = 0.86): { x: number; y: number; scale: number } {
    const scale = Math.min(Math.max(Math.min(this.width / r.w, this.height / r.h) * fill, this.minScale), this.maxScale)
    return { x: r.x + r.w / 2 - this.width / 2 / scale, y: r.y + r.h / 2 - this.height / 2 / scale, scale }
  }

  /** Shows `r`, flying there over `ms` (0 jumps). */
  fit(r: Rect, ms = 0, fill = 0.86): void {
    this.flyTo(this.fitted(r, fill), ms)
  }

  /** The view that makes `r` exactly as wide as the canvas, less `margin` CSS px a side, with its top `margin` below the canvas's. */
  fittedWidth(r: Rect, margin = 0): { x: number; y: number; scale: number } {
    const scale = Math.min(Math.max((this.width - margin * 2) / r.w, this.minScale), this.maxScale)
    return { x: r.x - margin / scale, y: r.y - margin / scale, scale }
  }

  /** The view a flight is on its way to; where it is now if it isn't flying. */
  get goal(): { x: number; y: number; scale: number } {
    return this.flight?.to ?? this
  }

  /** Moves to a view, flying there over `ms` (0 jumps). */
  flyTo(to: { x: number; y: number; scale: number }, ms = 0): void {
    this.velocity = null
    if (ms <= 0) {
      this.flight = null
      Object.assign(this, to)
      return
    }
    this.flight = { from: { x: this.x, y: this.y, scale: this.scale }, to, start: performance.now(), ms }
  }

  /** Starts coasting at a velocity in CSS px per ms (after a drag). */
  coast(vx: number, vy: number): void {
    this.flight = null
    this.velocity = Math.hypot(vx, vy) > 0.05 ? { x: vx, y: vy } : null
  }

  /** Stops any flight or coast (the person took over). */
  stop(): void {
    this.flight = null
    this.velocity = null
  }

  /** Advances a flight or coast to `now`; true while something is still moving. */
  step(now: number, dtMs: number): boolean {
    if (this.flight) {
      const f = this.flight
      const t = Math.min(1, (now - f.start) / f.ms)
      const e = 0.5 - Math.cos(Math.PI * t) / 2 // ease in and out
      // Zoom moves evenly in log space, and the centre follows it, so the flight doesn't swoop out and back.
      const scale = Math.exp(Math.log(f.from.scale) + (Math.log(f.to.scale) - Math.log(f.from.scale)) * e)
      const cx0 = f.from.x + this.width / 2 / f.from.scale
      const cy0 = f.from.y + this.height / 2 / f.from.scale
      const cx1 = f.to.x + this.width / 2 / f.to.scale
      const cy1 = f.to.y + this.height / 2 / f.to.scale
      this.scale = scale
      this.x = cx0 + (cx1 - cx0) * e - this.width / 2 / scale
      this.y = cy0 + (cy1 - cy0) * e - this.height / 2 / scale
      if (t >= 1) this.flight = null
      return this.flight !== null
    }
    if (this.velocity) {
      this.x -= (this.velocity.x * dtMs) / this.scale
      this.y -= (this.velocity.y * dtMs) / this.scale
      const decay = Math.pow(0.92, dtMs / 16.7)
      this.velocity.x *= decay
      this.velocity.y *= decay
      if (Math.hypot(this.velocity.x, this.velocity.y) < 0.02) this.velocity = null
      return this.velocity !== null
    }
    return false
  }
}
