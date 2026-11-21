// A file's diff, the way GitHub shows one: each hunk under a header naming where it is, old and new line numbers
// in a gutter, and between hunks a bar for the hidden lines with buttons to show 20 more above or below, or all
// of them. Expanding needs the whole file (FileInfo.text); without it the view shows the hunks alone.
//
// Highlighting runs over the whole file once, so a line inside a block comment that started outside its hunk is
// still coloured as one. Removed lines aren't in that file: they're highlighted in hunk order, starting from the
// state just before the hunk.

import type { FileInfo } from '../shared/types.ts'
import { languageOf, tokenizer, type LineState, type Token } from './highlight.ts'

/** Lines one click on an expand button shows. */
const STEP = 20

type Sign = '+' | '-' | ' '

interface Row {
  old: number | null
  new: number | null
  sign: Sign
  tokens: Token[]
}

interface Gap {
  /** new-file line numbers of the hidden run, inclusive; old = new + delta */
  from: number
  to: number
  delta: number
  /** lines shown so far from the top of the run and from its bottom */
  top: number
  bottom: number
  /** where in the file: before the first hunk, between two, or after the last (decides which buttons make sense) */
  where: 'start' | 'between' | 'end'
}

interface Section {
  header: string
  range: string
  rows: Row[]
}

export interface DiffView {
  /**
   * Shows unchanged lines around the hunks, a few at a time and evenly across every gap, until the view's
   * content is at least `height` px tall or there's nothing left to show: so a box bigger than its diff is filled
   * with the code around the change, not left blank.
   */
  fill(height: number): void
}

/** Lines one round of fill() shows on each side of each gap. */
const FILL_STEP = 3

/** Builds the view into `root` (emptied first). */
export function renderDiffView(root: HTMLElement, f: FileInfo): DiffView {
  root.textContent = ''
  root.classList.add('diffview')
  if (!f.hunks || f.hunks.length === 0) {
    root.appendChild(div('meta', `${f.status === 'unchanged' ? 'Unchanged' : f.status} · ${f.lines} lines`))
    return { fill: () => {} }
  }
  const tok = tokenizer(languageOf(f.path))
  const deleted = f.status === 'deleted'
  // The file at head (or at base, deleted), highlighted as one piece: tokens per line and the state before each.
  const fileLines = f.text !== undefined ? f.text.split('\n') : null
  if (fileLines && fileLines[fileLines.length - 1] === '') fileLines.pop()
  const tokens: Token[][] = []
  const before: LineState[] = []
  if (fileLines) {
    let state: LineState = { in: 'code' }
    for (const line of fileLines) {
      before.push(state)
      const r = tok.line(line, state)
      tokens.push(r.tokens)
      state = r.state
    }
  }
  /** Tokens for a line of the file by its number there, or highlighted alone if the file isn't stored. */
  const fileTokens = (no: number, text: string): Token[] => tokens[no - 1] ?? tok.line(text, { in: 'code' }).tokens

  const sections: Section[] = []
  const spans: { oldStart: number; newStart: number; newEnd: number }[] = []
  for (const h of f.hunks) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(h.header)
    let oldNo = m ? Number(m[1]) : 1
    let newNo = m ? Number(m[3]) : 1
    const oldStart = oldNo
    const newStart = newNo
    // Removed lines carry their own highlighter state, from the line before the hunk.
    let removed: LineState = before[(deleted ? oldNo : newNo) - 1] ?? { in: 'code' }
    const rows: Row[] = []
    for (const l of h.lines) {
      if (l.t === ' ') {
        // On the deleted side the file is the old one, numbered by old lines.
        rows.push({ old: oldNo, new: newNo, sign: ' ', tokens: fileTokens(deleted ? oldNo : newNo, l.s) })
        removed = before[deleted ? oldNo : newNo] ?? removed
        oldNo++
        newNo++
      } else if (l.t === '+') {
        rows.push({ old: null, new: newNo, sign: '+', tokens: fileTokens(newNo, l.s) })
        newNo++
      } else {
        const r = deleted ? { tokens: fileTokens(oldNo, l.s), state: before[oldNo] ?? removed } : tok.line(l.s, removed)
        removed = r.state
        rows.push({ old: oldNo, new: null, sign: '-', tokens: r.tokens })
        oldNo++
      }
    }
    sections.push({ header: m?.[5]?.trim() ?? '', range: m ? `${m[1]}${m[2] ? ',' + m[2] : ''} → ${m[3]}${m[4] ? ',' + m[4] : ''}` : h.header, rows })
    spans.push({ oldStart, newStart, newEnd: newNo - 1 })
  }

  // The hidden runs of unchanged lines, in the file the hunks are numbered against.
  const gaps: (Gap | null)[] = []
  const total = fileLines?.length ?? 0
  const lineOf = (s: (typeof spans)[number]) => (deleted ? s.oldStart : s.newStart)
  for (let i = 0; i <= spans.length; i++) {
    if (!fileLines) {
      gaps.push(null)
      continue
    }
    const prevEnd = i === 0 ? 0 : deleted ? spans[i - 1].oldStart + countOld(f.hunks[i - 1].lines) - 1 : spans[i - 1].newEnd
    const nextStart = i === spans.length ? total + 1 : lineOf(spans[i])
    const from = prevEnd + 1
    const to = nextStart - 1
    const delta = i === spans.length ? (i === 0 ? 0 : spans[i - 1].oldStart - spans[i - 1].newStart + (countOld(f.hunks[i - 1].lines) - countNew(f.hunks[i - 1].lines))) : spans[i].oldStart - spans[i].newStart
    gaps.push(to >= from ? { from, to, delta: deleted ? 0 : delta, top: 0, bottom: 0, where: i === 0 ? 'start' : i === spans.length ? 'end' : 'between' } : null)
  }

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
  /** An unchanged line of the file, for an expanded gap. */
  const contextRow = (no: number, g: Gap): Row => {
    const text = fileLines![no - 1]
    return deleted ? { old: no, new: null, sign: ' ', tokens: fileTokens(no, text) } : { old: no + g.delta, new: no, sign: ' ', tokens: fileTokens(no, text) }
  }

  const renderGap = (holder: HTMLElement, g: Gap) => {
    holder.textContent = ''
    for (let no = g.from; no < g.from + g.top; no++) holder.appendChild(rowEl(contextRow(no, g)))
    const hidden = g.to - g.from + 1 - g.top - g.bottom
    if (hidden > 0) {
      const bar = div('gap')
      const show = (label: string, title: string, act: () => void) => {
        const b = document.createElement('button')
        b.textContent = label
        b.title = title
        b.onclick = (e) => {
          e.stopPropagation()
          act()
          renderGap(holder, g)
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
      holder.appendChild(bar)
    }
    for (let no = g.to - g.bottom + 1; no <= g.to; no++) holder.appendChild(rowEl(contextRow(no, g)))
  }

  const holders: { g: Gap; holder: HTMLElement }[] = []
  const addGap = (g: Gap | null) => {
    if (!g) return
    const holder = div('gaprun')
    renderGap(holder, g)
    root.appendChild(holder)
    holders.push({ g, holder })
  }
  sections.forEach((s, i) => {
    addGap(gaps[i])
    const head = div('hh')
    head.appendChild(span('range', s.range))
    if (s.header) head.appendChild(span('ctx', s.header))
    root.appendChild(head)
    for (const r of s.rows) root.appendChild(rowEl(r))
  })
  addGap(gaps[sections.length])

  return {
    fill(height) {
      // The content's own height (scrollHeight never reads less than the box, so it can't tell an unfilled box).
      const content = () => {
        const last = root.lastElementChild as HTMLElement | null
        return last ? last.offsetTop + last.offsetHeight : 0
      }
      for (let round = 0; round < 400 && content() < height; round++) {
        let grew = false
        for (const { g, holder } of holders) {
          const hidden = g.to - g.from + 1 - g.top - g.bottom
          if (hidden <= 0) continue
          // Context above a change (the gap's bottom) and below one (its top), as the gap's place allows.
          const below = g.where === 'start' ? 0 : Math.min(FILL_STEP, hidden)
          const above = g.where === 'end' ? 0 : Math.min(FILL_STEP, hidden - below)
          g.top += below
          g.bottom += above
          if (below + above > 0) {
            renderGap(holder, g)
            grew = true
          }
        }
        if (!grew) break
      }
    },
  }
}

function countOld(lines: { t: Sign }[]): number {
  return lines.filter((l) => l.t !== '+').length
}

function countNew(lines: { t: Sign }[]): number {
  return lines.filter((l) => l.t !== '-').length
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
