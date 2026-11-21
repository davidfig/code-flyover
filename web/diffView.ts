// A file's diff, the way GitHub shows one: each hunk under a header naming where it is, old and new line numbers
// in a gutter, and between hunks a bar for the hidden lines with buttons to show 20 more above or below, or all
// of them. Expanding needs the whole file (FileInfo.text); without it the view shows the hunks alone.
//
// Highlighting runs over the whole file once, so a line inside a block comment that started outside its hunk is
// still coloured as one. Removed lines aren't in that file: they're highlighted in hunk order, starting from the
// state just before the hunk.
//
// Only what can be seen is built. The view is a list of items (hunk headers, rows, gap bars) in chunks; a chunk
// near the visible part of the box is built, the rest are empty placeholders as tall as their rows are estimated to
// wrap to, and a built chunk far from view is emptied again. So a page holds about a screenful of rows per diff, at
// any size of PR. render() says what's visible; as estimates become real heights above it, it reports the shift so
// the caller can keep the text still.

import type { FileInfo } from '../shared/types.ts'
import { diffModel, FILL_STEP, STEP, type Gap, type Item, type Row } from './diffModel.ts'


export interface DiffView {
  /**
   * Shows unchanged lines around the hunks, a few at a time and evenly across every gap, until the view's
   * content is at least `height` px tall or there's nothing left to show: so a box bigger than its diff is filled
   * with the code around the change, not left blank.
   */
  fill(height: number): void
  /**
   * Builds the rows near the visible part (`top` and `height`: the scroll position and the visible height, `width`:
   * the width lines wrap at, all in the view's own px) and empties ones far from it. Returns how far the content
   * above `top` grew or shrank from re-estimating at a new width: add it to the scroll position. (Built chunks' real
   * heights arrive later, through onShift.)
   */
  render(top: number, height: number, width: number): number
}

export interface DiffViewOptions {
  /** the view scrolls by itself (the side panel): render on its own scroll events */
  selfScroll?: boolean
  /**
   * Content above the visible part changed height by `delta` px (a chunk's estimate became its real height): move
   * the scroll position by it to keep the text still. Called after layout, before paint, so nothing visibly jumps.
   */
  onShift?(delta: number): void
}

/** Items per chunk: the unit that's built or emptied. */
const CHUNK = 40
/** Estimating heights: a row (12px text, line-height 1.4), a hunk header, a gap bar; the gutter's width; a character. */
const ROW_H = 16.8
const HEAD_H = 23
const BAR_H = 22
const GUTTER_PX = 104
const CHAR_PX = 7.22


/** Builds the view into `root` (emptied first). Nothing is built until render() (or, with selfScroll, at once). */
export function renderDiffView(root: HTMLElement, f: FileInfo, opts: DiffViewOptions = {}): DiffView {
  root.textContent = ''
  root.classList.add('diffview')
  if (!f.hunks || f.hunks.length === 0) {
    root.appendChild(div('meta', `${f.status === 'unchanged' ? 'Unchanged' : f.status} · ${f.lines} lines`))
    return { fill: () => {}, render: () => 0 }
  }
  const model = diffModel(f)!
  const { gaps } = model
  const items = () => model.items()

  const rowEl = (r: Row) => {
    const el = div(`l ${r.sign === '+' ? 'a' : r.sign === '-' ? 'd' : 'c'}`)
    el.appendChild(div('no', r.old === null ? '' : String(r.old)))
    el.appendChild(div('no', r.new === null ? '' : String(r.new)))
    el.appendChild(div('sg', r.sign === ' ' ? '' : r.sign === '-' ? '−' : '+'))
    const code = div('code')
    for (const t of r.tokens) {
      if (t.kind === 'plain') code.appendChild(document.createTextNode(t.text))
      else code.appendChild(span('tk-' + t.kind, t.text))
    }
    if (!r.tokens.length) code.textContent = ' '
    el.appendChild(code)
    return el
  }
  const itemEl = (it: Item): HTMLElement => {
    if (it.kind === 'row') return rowEl(it.row)
    if (it.kind === 'head') {
      const head = div('hh')
      head.appendChild(span('range', it.s.range))
      if (it.s.header) head.appendChild(span('ctx', it.s.header))
      return head
    }
    const g = it.g
    const hidden = g.to - g.from + 1 - g.top - g.bottom
    const bar = div('gap')
    const show = (label: string, title: string, act: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.onclick = (e) => {
        e.stopPropagation()
        act()
        rebuild()
      }
      bar.appendChild(b)
    }
    if (hidden <= STEP) show(`Show ${hidden} line${hidden === 1 ? '' : 's'}`, 'Show the hidden lines', () => (g.top += hidden))
    else {
      // Down from the hunk above, up from the hunk below: whichever makes sense where the gap is.
      if (g.where !== 'start') show(`↓ ${STEP}`, `Show ${STEP} more lines below the change above`, () => (g.top += STEP))
      if (g.where !== 'end') show(`↑ ${STEP}`, `Show ${STEP} more lines above the change below`, () => (g.bottom += STEP))
      show(`All ${hidden}`, 'Show all the hidden lines', () => (g.top += hidden))
    }
    bar.appendChild(span('count', `${hidden} unchanged line${hidden === 1 ? '' : 's'}`))
    return bar
  }

  /** An item's height before it's built: rows by how many times their text wraps at `width`. */
  const estimate = (it: Item, width: number): number => {
    if (it.kind === 'head') return HEAD_H
    if (it.kind === 'bar') return BAR_H
    const perLine = Math.max(12, Math.floor((width - GUTTER_PX) / CHAR_PX))
    let chars = 0
    for (const t of it.row.tokens) chars += t.text.length
    return ROW_H * Math.max(1, Math.ceil(chars / perLine))
  }

  // ---- chunks: built near the visible part, placeholders elsewhere ----
  interface Chunk {
    items: Item[]
    el: HTMLElement
    /** its height: estimated until built, then measured */
    h: number
    live: boolean
    /** the width it was measured or estimated at (wrapping changes with it) */
    at: number
  }
  let chunks: Chunk[] = []
  let width = 0
  let last = { top: 0, height: 0, width: 0 }
  // Built chunks report their real height when the browser lays them out anyway: asking for it as each is built
  // forced a layout per chunk, hundreds in a row on a big PR.
  const byEl = new Map<Element, Chunk>()
  const observer = new ResizeObserver((entries) => {
    let shift = 0
    for (const e of entries) {
      const c = byEl.get(e.target)
      if (!c || !c.live) continue
      const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight
      if (Math.abs(h - c.h) < 0.5) continue
      // Above what's visible: the text below would move, so the scroll moves with it.
      let y = 0
      for (const o of chunks) {
        if (o === c) break
        y += o.h
      }
      if (y + c.h <= last.top) shift += h - c.h
      c.h = h
    }
    if (shift) {
      last.top += shift
      if (opts.selfScroll) root.scrollTop += shift
      opts.onShift?.(shift)
    }
  })
  const placeholder = (c: Chunk) => {
    c.el.textContent = ''
    c.el.style.height = `${c.h}px`
    c.live = false
    observer.unobserve(c.el)
  }
  const rebuild = () => {
    const all = items()
    for (const c of chunks) observer.unobserve(c.el)
    byEl.clear()
    root.textContent = ''
    chunks = []
    for (let i = 0; i < all.length; i += CHUNK) {
      const list = all.slice(i, i + CHUNK)
      const c: Chunk = { items: list, el: div('chunk'), h: 0, live: false, at: width }
      c.h = list.reduce((t, it) => t + estimate(it, width || 560), 0)
      placeholder(c)
      root.appendChild(c.el)
      chunks.push(c)
      byEl.set(c.el, c)
    }
    if (last.height) render(last.top, last.height, last.width)
  }
  const render = (top: number, height: number, w: number): number => {
    last = { top, height, width: w }
    width = w
    const margin = Math.max(height / 2, 150)
    let y = 0
    let shift = 0
    for (const c of chunks) {
      const near = y + c.h > top - margin && y < top + height + margin
      const far = y + c.h < top - margin * 3 || y > top + height + margin * 3
      const above = y + c.h <= top
      if (near && !c.live) {
        // Build it; its real height comes from the observer once the browser lays it out.
        c.el.style.height = ''
        for (const it of c.items) c.el.appendChild(itemEl(it))
        c.live = true
        c.at = w
        observer.observe(c.el)
      } else if (c.live && Math.abs(c.at - w) > 1) {
        c.at = w // a new wrapping width: the observer reports the new height
      } else if (far && c.live) placeholder(c)
      else if (!c.live && Math.abs(c.at - w) > 1) {
        // A placeholder whose wrapping width changed: estimate again.
        const h = c.items.reduce((t, it) => t + estimate(it, w), 0)
        if (above) shift += h - c.h
        c.h = h
        c.at = w
        c.el.style.height = `${h}px`
      }
      y += c.h
    }
    return shift
  }
  rebuild()

  if (opts.selfScroll) {
    const draw = () => render(root.scrollTop, root.clientHeight, root.clientWidth)
    root.addEventListener('scroll', draw, { passive: true })
    requestAnimationFrame(draw)
  }

  return {
    fill(height) {
      // The content's height from the chunks (estimated where not built), so this needs no layout.
      const content = () => chunks.reduce((t, c) => t + c.h, 0)
      for (let round = 0; round < 400 && content() < height; round++) {
        if (!model.growAll(FILL_STEP)) break
        rebuild()
      }
    },
    render,
  }
}

function div(cls: string, text?: string): HTMLElement {
  const el = document.createElement('div')
  el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement('span')
  el.className = cls
  el.textContent = text
  return el
}
