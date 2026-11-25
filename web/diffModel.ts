// A file's diff as data: hunks as sections of rows with old and new line numbers, the gaps of unchanged lines
// between them (and how much of each is shown), and the list of items the view shows in order. No page code, so the
// layout worker (drawing text in WebGL) and the side panel's HTML view share it.
//
// Highlighting runs over the whole file once, so a line inside a block comment that started outside its hunk is
// still coloured as one. Removed lines aren't in that file: they're highlighted in hunk order, starting from the
// state just before the hunk.

import type { FileInfo } from '../shared/types.ts'
import { languageOf, tokenizer, type LineState, type Token, type Tokenizer } from './highlight.ts'

/** Lines one click on an expand button shows. */
export const STEP = 20
/** Lines one round of filling a box shows on each side of each gap. */
export const FILL_STEP = 3

export type Sign = '+' | '-' | ' '

export interface Row {
  old: number | null
  new: number | null
  sign: Sign
  tokens: Token[]
}

export interface Gap {
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

export interface Section {
  header: string
  range: string
  rows: Row[]
}

export type Item = { kind: 'row'; row: Row } | { kind: 'head'; s: Section } | { kind: 'bar'; g: Gap; index: number }

export interface DiffModel {
  sections: Section[]
  /** one per place a gap can be (before each hunk, and after the last); null where there's nothing hidden */
  gaps: (Gap | null)[]
  /** what the view shows, in order, given how far each gap is expanded */
  items(): Item[]
  /** shows more context around every hunk, `step` lines a side; false when nothing was left to show */
  growAll(step: number): boolean
}

/** A file's lines, highlighted: tokens per line and the state before each. */
export interface Highlighted {
  tok: Tokenizer
  tokens: Token[][]
  before: LineState[]
}

/** The file at head (or at base, deleted) as lines, where it's stored. */
export function fileLinesOf(f: FileInfo): string[] | null {
  if (f.text === undefined) return null
  const lines = f.text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Highlights lines one at a time, for the caller to run to the end at once or in slices. */
export function* highlighting(lines: string[], tok: Tokenizer): Generator<void, Highlighted> {
  const tokens: Token[][] = []
  const before: LineState[] = []
  let state: LineState = { in: 'code' }
  for (const line of lines) {
    before.push(state)
    const r = tok.line(line, state)
    tokens.push(r.tokens)
    state = r.state
    yield
  }
  return { tok, tokens, before }
}

function highlightNow(lines: string[], tok: Tokenizer): Highlighted {
  const run = highlighting(lines, tok)
  for (;;) {
    const r = run.next()
    if (r.done) return r.value
  }
}

/** The diff of a file with hunks (null when it has none), coloured by the quick tokenizer unless it's given better. */
export function diffModel(f: FileInfo, better?: Highlighted): DiffModel | null {
  if (!f.hunks || f.hunks.length === 0) return null
  const deleted = f.status === 'deleted'
  // The file at head (or at base, deleted), highlighted as one piece: tokens per line and the state before each.
  const fileLines = fileLinesOf(f)
  const { tok, tokens, before } = better ?? highlightNow(fileLines ?? [], tokenizer(languageOf(f.path)))
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

  /** An unchanged line of the file, for an expanded gap. */
  const contextRow = (no: number, g: Gap): Row => {
    const text = fileLines![no - 1]
    return deleted ? { old: no, new: null, sign: ' ', tokens: fileTokens(no, text) } : { old: no + g.delta, new: no, sign: ' ', tokens: fileTokens(no, text) }
  }

  // ---- the item list: what the view shows, in order ----
  const gapItems = (g: Gap | null, out: Item[], index: number) => {
    if (!g) return
    for (let no = g.from; no < g.from + g.top; no++) out.push({ kind: 'row', row: contextRow(no, g) })
    if (g.to - g.from + 1 - g.top - g.bottom > 0) out.push({ kind: 'bar', g, index })
    for (let no = g.to - g.bottom + 1; no <= g.to; no++) out.push({ kind: 'row', row: contextRow(no, g) })
  }
  const items = (): Item[] => {
    const out: Item[] = []
    sections.forEach((s, i) => {
      gapItems(gaps[i], out, i)
      if (f.status !== 'unchanged') out.push({ kind: 'head', s }) // an unchanged file is one plain run of lines
      for (const r of s.rows) out.push({ kind: 'row', row: r })
    })
    gapItems(gaps[sections.length], out, sections.length)
    return out
  }

  return {
    sections,
    gaps,
    items,
    growAll(step) {
      let grew = false
      for (const g of gaps) {
        if (!g) continue
        const hidden = g.to - g.from + 1 - g.top - g.bottom
        if (hidden <= 0) continue
        // Context above a change (the gap's bottom) and below one (its top), as the gap's place allows.
        const below = g.where === 'start' ? 0 : Math.min(step, hidden)
        const above = g.where === 'end' ? 0 : Math.min(step, hidden - below)
        g.top += below
        g.bottom += above
        if (below + above > 0) grew = true
      }
      return grew
    },
  }
}

function countOld(lines: { t: Sign }[]): number {
  return lines.filter((l) => l.t !== '+').length
}

function countNew(lines: { t: Sign }[]): number {
  return lines.filter((l) => l.t !== '-').length
}
