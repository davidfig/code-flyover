// The text layout worker: highlights files, wraps their lines and turns them into GPU instances (see layout.ts),
// off the main thread. It owns each file's diff model, so how far each gap is expanded lives here too.
//
// In:  { type: 'init', metrics }                                 the face's glyph map and metrics
//      { type: 'settings', values }                              the page's settings (settings.ts), before the files they lay out
//      { type: 'files', files: { id, file }[] }                  the analysis' changed files (replaces any before)
//      { type: 'focus', selected, visible }                      what to give its better colours first
//      { type: 'layout', id, width, fillTo?, seq }               lay a file out at a width (filling a box that tall)
//      { type: 'expand', id, gap, action, width, seq }           a gap bar's button, then lay it out again
//
// A file is laid out at once with the quick tokenizer's colours. Its language's grammar (shiki.ts) is slow, so it runs
// afterwards, in short slices between messages: the file being read first, then those in view. Each file is sent again
// with the better colours when it's done.
//
// Out: { type: 'laid', id, seq, again, ...Laid }                 instances transferred, not copied

import type { FileInfo } from '../../shared/types.ts'
import { diffModel, fileLinesOf, FILL_STEP, highlighting, type DiffModel, type Highlighted } from '../diffModel.ts'
import type { FaceMetrics } from '../gl/text.ts'
import { expandGap, layoutDiff, type GapAction, type Laid } from './layout.ts'
import { update, type Settings } from '../settings.ts'
import { grammarFor } from '../shiki.ts'

export type ToWorker =
  | { type: 'init'; metrics: FaceMetrics }
  | { type: 'settings'; values: Settings }
  | { type: 'files'; files: { id: number; file: FileInfo }[] }
  | { type: 'focus'; selected: number | null; visible: number[] }
  | { type: 'layout'; id: number; width: number; fillTo?: number; seq: number }
  | { type: 'expand'; id: number; gap: number; action: GapAction; width: number; seq: number }

let metrics: FaceMetrics | null = null
const files = new Map<number, FileInfo>()
const models = new Map<number, DiffModel | null>()

const modelOf = (id: number) => {
  if (!models.has(id)) {
    const f = files.get(id)
    const done = f && finished.get(f.path)
    const same = done && done.text === f.text
    if (same) queued.add(id) // nothing left to do
    models.set(id, f ? diffModel(f, same ? done.h : undefined) : null)
  }
  return models.get(id) ?? null
}

const post = (id: number, seq: number, laid: Laid, again = false) =>
  (self as unknown as Worker).postMessage({ type: 'laid', id, seq, again, ...laid }, [laid.glyphs, laid.rects])

/** What each file was last sent as, to send it again when its grammar is done with it. */
const sent = new Map<number, { seq: number; width: number }>()

// ---- better colours, in the background ----

/** Files waiting for their grammar, in the order they were first laid out. Each is queued once. */
const queue = new Set<number>()
const queued = new Set<number>()
/** Files part way through: one that's being read overtakes them, and they go on from where they were. */
const started = new Map<number, Generator<void, Highlighted>>()
/** Finished files' highlighting by path, kept for as long as the text is the same (a re-layout resends the files). */
const finished = new Map<string, { text: string | undefined; h: Highlighted }>()
/** The file being read, then the ones in view. */
let focus: { selected: number | null; visible: Set<number> } = { selected: null, visible: new Set() }
let running = false
/** counts the sets of files, so work on an earlier one stops */
let generation = 0
/** How long to highlight before letting messages through, ms. */
const SLICE_MS = 12

const refine = (id: number) => {
  if (queued.has(id)) return
  queued.add(id)
  queue.add(id)
  if (!running) void run()
}

const nextInQueue = (): number | undefined => {
  if (focus.selected !== null && queue.has(focus.selected)) return focus.selected
  let first: number | undefined
  for (const id of queue) {
    if (focus.visible.has(id)) return id
    first ??= id
  }
  return first
}

/** Lets waiting messages be handled before going on (a timer would too, but waits 4ms each time). */
const channel = new MessageChannel()
let resume = () => {}
channel.port1.onmessage = () => resume()
const breathe = () =>
  new Promise<void>((r) => {
    resume = r
    channel.port2.postMessage(0)
  })

async function run() {
  running = true
  for (;;) {
    const id = nextInQueue()
    if (id === undefined) break
    try {
      if (await refineSlice(id)) {
        queue.delete(id)
        started.delete(id)
      }
    } catch (e) {
      console.warn(`Highlighting ${files.get(id)?.path} failed`, e)
      queue.delete(id)
      started.delete(id)
    }
    await breathe()
  }
  running = false
}

/** Highlights some of a file; true when there's no more to do (or the files changed, and it isn't this queue's). */
async function refineSlice(id: number): Promise<boolean> {
  const mine = generation
  const f = files.get(id)
  if (!f) return true
  let work = started.get(id)
  if (!work) {
    const tok = await grammarFor(f.path)
    // The files changed while the grammar loaded: the id may be another file's now, still to do.
    if (mine !== generation) return false
    if (!tok) return true
    started.set(id, (work = highlighting(fileLinesOf(f) ?? [], tok)))
  }
  const until = performance.now() + SLICE_MS
  do {
    const r = work.next()
    if (r.done) {
      finished.set(f.path, { text: f.text, h: r.value })
      recolour(id, f, r.value)
      return true
    }
  } while (performance.now() < until)
  return false
}

function recolour(id: number, f: FileInfo, h: Highlighted) {
  const was = models.get(id)
  const model = diffModel(f, h)
  if (!was || !model) return
  // What's expanded stays expanded.
  model.gaps.forEach((g, i) => g && was.gaps[i] && Object.assign(g, { top: was.gaps[i].top, bottom: was.gaps[i].bottom }))
  models.set(id, model)
  const last = sent.get(id)
  if (last) post(id, last.seq, layoutDiff(model, metrics!, last.width), true)
}

const send = (id: number, seq: number, laid: Laid, width: number) => {
  sent.set(id, { seq, width })
  post(id, seq, laid)
  refine(id)
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type === 'init') metrics = msg.metrics
  else if (msg.type === 'settings') update(msg.values, false)
  else if (msg.type === 'files') {
    files.clear()
    models.clear()
    sent.clear()
    queue.clear()
    queued.clear()
    started.clear()
    focus = { selected: null, visible: new Set() }
    generation++
    for (const { id, file } of msg.files) files.set(id, file)
    const texts = new Map(msg.files.map(({ file }) => [file.path, file.text]))
    for (const [path, f] of finished) if (!texts.has(path) || texts.get(path) !== f.text) finished.delete(path)
  } else if (msg.type === 'focus') {
    focus = { selected: msg.selected, visible: new Set(msg.visible) }
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
    send(msg.id, msg.seq, laid, msg.width)
  } else if (msg.type === 'expand') {
    const model = modelOf(msg.id)
    if (!model || !metrics) return
    expandGap(model, msg.gap, msg.action)
    send(msg.id, msg.seq, layoutDiff(model, metrics, msg.width), msg.width)
  }
}
