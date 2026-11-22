// Trackpad, mouse and touch input for the camera.
//
// The wheel and gesture handling is golemdocs' (client/src/main.ts): two-finger scroll pans, a trackpad pinch
// (ctrl+wheel in Chrome and Firefox, gesture events in Safari) zooms, and cmd/ctrl+wheel zooms with a mouse.
// macOS doesn't flag momentum scrolling, so while a scroll is still coasting a held cmd only takes over once the
// deltas jump (fresh input). Added here: drag to pan with a coast on release, two-finger touch pinch, click and
// double-click, and a hook that lets the map take a wheel event first (scrolling a file's diff).

import type { Camera } from './camera.ts'
import { settings } from '../settings.ts'

export interface InputEvents {
  /** The camera moved, or may be moving: draw. */
  changed(): void
  /** A click that didn't drag, in CSS px on the canvas. */
  click(cssX: number, cssY: number, double: boolean): void
  /** Offered every wheel event that isn't a zoom first; return true to take it (the camera doesn't move). */
  wheel?(e: WheelEvent, cssX: number, cssY: number, dx: number, dy: number): boolean
}

const WHEEL_GESTURE_GAP_MS = 200
const CLICK_SLOP_PX = 4

export function attachInput(el: HTMLElement, camera: Camera, events: InputEvents): void {
  // ---- wheel: pan, or zoom on a pinch or with ctrl/cmd ----
  let wheelZooming = false
  let lastWheelTime = -Infinity
  let lastWheelMagnitude = 0
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientHeight : 1
      const zoomKey = e.ctrlKey || e.metaKey
      const magnitude = Math.hypot(e.deltaX, e.deltaY) * unit
      const coasting = e.timeStamp - lastWheelTime <= WHEEL_GESTURE_GAP_MS && magnitude <= lastWheelMagnitude * 2 + 8
      if (!zoomKey) wheelZooming = false
      else if (wheelZooming || !coasting) wheelZooming = true
      lastWheelTime = e.timeStamp
      lastWheelMagnitude = magnitude
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      if (wheelZooming) camera.zoomAt(x, y, Math.exp(-e.deltaY * unit * 0.01 * settings.zoomSpeed))
      else if (events.wheel?.(e, x, y, e.deltaX * unit, e.deltaY * unit)) return
      else camera.panBy(e.deltaX * unit, e.deltaY * unit)
      events.changed()
    },
    { passive: false },
  )

  // ---- Safari's trackpad pinch: gesture events with a running scale ----
  type GestureEvent = Event & { scale: number; clientX: number; clientY: number }
  let gestureScale = 1
  el.addEventListener('gesturestart', (ev) => {
    ev.preventDefault()
    gestureScale = (ev as GestureEvent).scale || 1
  })
  el.addEventListener('gesturechange', (ev) => {
    ev.preventDefault()
    const g = ev as GestureEvent
    const r = el.getBoundingClientRect()
    camera.zoomAt(g.clientX - r.left, g.clientY - r.top, (g.scale / gestureScale) ** settings.zoomSpeed)
    gestureScale = g.scale
    events.changed()
  })
  el.addEventListener('gestureend', (ev) => ev.preventDefault())

  // ---- pointers: drag to pan (coasting on release), two-finger touch pinch, click ----
  const pointers = new Map<number, { x: number; y: number }>()
  let down: { x: number; y: number; moved: boolean } | null = null
  let trail: { t: number; x: number; y: number }[] = []
  let pinchDist = 0
  let lastClick = { t: -Infinity, x: 0, y: 0 }
  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    // Controls on top of the map (change cards) take their own clicks.
    if ((e.target as Element).closest('button, a, input, select')) return
    el.setPointerCapture(e.pointerId)
    const p = local(e)
    pointers.set(e.pointerId, p)
    camera.stop()
    if (pointers.size === 1) {
      down = { ...p, moved: false }
      trail = [{ t: e.timeStamp, ...p }]
    } else {
      down = null
      const [a, b] = [...pointers.values()]
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    }
  })
  el.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    const p = local(e)
    pointers.set(e.pointerId, p)
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist > 0) camera.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (dist / pinchDist) ** settings.zoomSpeed)
      // Both fingers moving together also pan.
      camera.panBy((prev.x - p.x) / 2, (prev.y - p.y) / 2)
      pinchDist = dist
      events.changed()
      return
    }
    if (!down) return
    if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) < CLICK_SLOP_PX) return
    down.moved = true
    camera.panBy(prev.x - p.x, prev.y - p.y)
    trail.push({ t: e.timeStamp, ...p })
    if (trail.length > 6) trail.shift()
    events.changed()
  })
  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    if (pointers.size > 0) return
    if (down && !down.moved && e.type === 'pointerup') {
      const p = local(e)
      const double = e.timeStamp - lastClick.t < settings.doubleClickMs && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < CLICK_SLOP_PX * 2
      lastClick = { t: double ? -Infinity : e.timeStamp, ...p }
      events.click(p.x, p.y, double)
    } else if (down?.moved && trail.length >= 2) {
      // Coast at the speed of the last few moves, if the pointer was still moving when it let go.
      const a = trail[0]
      const b = trail[trail.length - 1]
      const dt = b.t - a.t
      if (dt > 0 && e.timeStamp - b.t < 80) camera.coast((b.x - a.x) / dt, (b.y - a.y) / dt)
      events.changed()
    }
    down = null
  }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}
