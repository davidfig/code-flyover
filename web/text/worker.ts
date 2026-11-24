// The text layout worker: highlights files, wraps their lines and turns them into GPU instances (see layout.ts),
// off the main thread. It owns each file's diff model, so how far each gap is expanded lives here too.
//
// In:  { type: 'init', metrics }                                 the face's glyph map and metrics
//      { type: 'settings', values }                              the page's settings (settings.ts), before the files they lay out
//      { type: 'files', files: { id, file }[] }                  the analysis' changed files (replaces any before)
//      { type: 'layout', id, width, fillTo?, seq }               lay a file out at a width (filling a box that tall)
//      { type: 'expand', id, gap, action, width, seq }           a gap bar's button, then lay it out again
// Out: { type: 'laid', id, seq, ...Laid }                        instances transferred, not copied

import type { FileInfo } from '../../shared/types.ts'
import { diffModel, FILL_STEP, type DiffModel } from '../diffModel.ts'
import type { FaceMetrics } from '../gl/text.ts'
import { expandGap, layoutDiff, type GapAction } from './layout.ts'
import { update, type Settings } from '../settings.ts'

export type ToWorker =
  | { type: 'init'; metrics: FaceMetrics }
  | { type: 'settings'; values: Settings }
  | { type: 'files'; files: { id: number; file: FileInfo }[] }
  | { type: 'layout'; id: number; width: number; fillTo?: number; seq: number }
  | { type: 'expand'; id: number; gap: number; action: GapAction; width: number; seq: number }

let metrics: FaceMetrics | null = null
const files = new Map<number, FileInfo>()
const models = new Map<number, DiffModel | null>()

const modelOf = (id: number) => {
  if (!models.has(id)) {
    const f = files.get(id)
    models.set(id, f ? diffModel(f) : null)
  }
  return models.get(id) ?? null
}

const send = (id: number, seq: number, model: DiffModel, width: number) => {
  const laid = layoutDiff(model, metrics!, width)
  ;(self as unknown as Worker).postMessage({ type: 'laid', id, seq, ...laid }, [laid.glyphs, laid.rects])
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type === 'init') metrics = msg.metrics
  else if (msg.type === 'settings') update(msg.values, false)
  else if (msg.type === 'files') {
    files.clear()
    models.clear()
    for (const { id, file } of msg.files) files.set(id, file)
  } else if (msg.type === 'layout') {
    const model = modelOf(msg.id)
    if (!model || !metrics) return
    let laid = layoutDiff(model, metrics, msg.width)
    // A box taller than its diff: show the code around the changes until it's full.
    // Never past full: code pushed out of the box would have to be scrolled to.
    if (msg.fillTo) {
      const grow = (step: number, rounds: number) => {
        for (let round = 0; round < rounds && laid.height < msg.fillTo!; round++) {
          const was = model.gaps.map((g) => g && { top: g.top, bottom: g.bottom })
          if (!model.growAll(step)) return
          const next = layoutDiff(model, metrics!, msg.width)
          if (next.height > msg.fillTo!) {
            model.gaps.forEach((g, i) => g && Object.assign(g, was[i]))
            return
          }
          laid = next
        }
      }
      grow(FILL_STEP, 400)
      grow(1, FILL_STEP)
    }
    ;(self as unknown as Worker).postMessage({ type: 'laid', id: msg.id, seq: msg.seq, ...laid }, [laid.glyphs, laid.rects])
  } else if (msg.type === 'expand') {
    const model = modelOf(msg.id)
    if (!model || !metrics) return
    expandGap(model, msg.gap, msg.action)
    send(msg.id, msg.seq, model, msg.width)
  }
}
