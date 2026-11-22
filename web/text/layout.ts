// Lays a file's diff out as GPU instances: a glyph per character and rectangles for row backgrounds, in the file's
// own text px (12px monospace, y down from the top of its first row). Pure (no page, no GPU), so it runs in the
// layout worker and in tests. The geometry follows the HTML view it replaces: old and new line numbers, a sign,
// then the code, wrapped at a space where it can be (with the continuation indented); hunk headers; gap bars with
// buttons, whose positions come back so the map can handle clicks on them.

import { rgba } from '../gl/program.ts'
import { GLYPH_BYTES, RECT_BYTES, type FaceMetrics } from '../gl/text.ts'
import type { DiffModel, Item } from '../diffModel.ts'
import { settings, tabSpaces } from '../settings.ts'
import type { TokenKind } from '../highlight.ts'

export const FONT_PX = 12
export const ROW_H = 16.8
export const HEAD_H = 23
export const BAR_H = 22
const BAR_FONT_PX = 11
const NUM_FONT_PX = 11
const PAD_RIGHT = 8

/** What a click on a gap bar's button does. */
export type GapAction = 'down' | 'up' | 'all'

export interface ButtonHit {
  gap: number
  action: GapAction
  x0: number
  x1: number
  y0: number
  y1: number
}

export interface Laid {
  glyphs: ArrayBuffer
  glyphCount: number
  rects: ArrayBuffer
  rectCount: number
  /** the content's height, text px */
  height: number
  /** the width it was wrapped at, text px */
  width: number
  buttons: ButtonHit[]
}

const COLORS: Record<TokenKind, number> = {
  plain: 0x2b2a27,
  keyword: 0x8a2f9c,
  string: 0x2f7a3c,
  comment: 0x8a857a,
  number: 0xb0561a,
  type: 0x1f5ea8,
  punct: 0x6b675d,
}

class Out {
  g = new ArrayBuffer(4096 * GLYPH_BYTES)
  gf = new Float32Array(this.g)
  gu16 = new Uint16Array(this.g)
  gu32 = new Uint32Array(this.g)
  gn = 0
  r = new ArrayBuffer(1024 * RECT_BYTES)
  rf = new Float32Array(this.r)
  ru32 = new Uint32Array(this.r)
  rn = 0

  glyph(x: number, y: number, size: number, glyph: number, color: number) {
    if ((this.gn + 1) * GLYPH_BYTES > this.g.byteLength) {
      const g = new ArrayBuffer(this.g.byteLength * 2)
      new Uint8Array(g).set(new Uint8Array(this.g))
      this.g = g
      this.gf = new Float32Array(g)
      this.gu16 = new Uint16Array(g)
      this.gu32 = new Uint32Array(g)
    }
    const f = this.gn * 5
    this.gf[f] = x
    this.gf[f + 1] = y
    this.gf[f + 2] = size
    this.gu16[this.gn * 10 + 6] = glyph
    this.gu32[f + 4] = color
    this.gn++
  }

  rect(x: number, y: number, w: number, h: number, color: number) {
    if ((this.rn + 1) * RECT_BYTES > this.r.byteLength) {
      const r = new ArrayBuffer(this.r.byteLength * 2)
      new Uint8Array(r).set(new Uint8Array(this.r))
      this.r = r
      this.rf = new Float32Array(r)
      this.ru32 = new Uint32Array(r)
    }
    const f = this.rn * 5
    this.rf[f] = x
    this.rf[f + 1] = y
    this.rf[f + 2] = w
    this.rf[f + 3] = h
    this.ru32[f + 4] = color
    this.rn++
  }
}

/** Lays out `model` wrapped at `width` text px. */
export function layoutDiff(model: DiffModel, m: FaceMetrics, width: number): Laid {
  const out = new Out()
  const ch = m.advance * FONT_PX
  const noW = 4.5 * ch
  const codeX = noW * 2 + 2 * ch
  const firstX = codeX + 0.5 * ch
  const contX = codeX + 2 * ch
  const baseline = (rowH: number, px: number) => (rowH - px * m.lineHeight) / 2 + px * m.ascender
  const glyphOf = (cp: number) => m.glyphOf[cp] ?? m.glyphOf[0x3f]
  const buttons: ButtonHit[] = []

  /** Writes `text` from x on the baseline at y; returns the x after it. Spaces take room but no instance. */
  const write = (text: string, x: number, y: number, px: number, color: number) => {
    const adv = m.advance * px
    for (const c of text) {
      const cp = c.codePointAt(0)!
      if (cp !== 32 && cp !== 9) out.glyph(x, y, px, glyphOf(cp), color)
      x += cp === 9 ? adv * settings.tabWidth : adv
    }
    return x
  }

  // The page under the text, then everything in order down it.
  out.rect(0, 0, width, 1e6, rgba(0xffffff, 0.95))
  let y = 0
  const perFirst = Math.max(8, Math.floor((width - PAD_RIGHT - firstX) / ch))
  const perCont = Math.max(8, Math.floor((width - PAD_RIGHT - contX) / ch))

  for (const it of model.items()) {
    if (it.kind === 'head') y = head(it, y)
    else if (it.kind === 'bar') y = bar(it, y)
    else y = row(it, y)
  }

  function row(it: Extract<Item, { kind: 'row' }>, top: number): number {
    const r = it.row
    // Break the line into visual lines: at a space near the edge where there is one, else hard.
    const chars: { c: string; kind: TokenKind }[] = []
    for (const t of r.tokens) for (const c of t.text.replace(/\t/g, tabSpaces())) chars.push({ c, kind: t.kind })
    const lines: (typeof chars)[] = []
    let start = 0
    let per = perFirst
    while (start < chars.length || lines.length === 0) {
      if (chars.length - start <= per) {
        lines.push(chars.slice(start))
        break
      }
      let cut = start + per
      for (let i = cut; i > start + per * 0.6; i--) {
        if (chars[i - 1].c === ' ') {
          cut = i
          break
        }
      }
      lines.push(chars.slice(start, cut))
      start = cut
      per = perCont
    }
    const h = lines.length * ROW_H
    const bg = r.sign === '+' ? 0xe3f4e8 : r.sign === '-' ? 0xfbe4e6 : 0
    const gutter = r.sign === '+' ? 0xcdebd6 : r.sign === '-' ? 0xf6cfd3 : 0
    if (bg) {
      out.rect(0, top, width, h, rgba(bg))
      out.rect(0, top, noW * 2, h, rgba(gutter))
    }
    const numColor = rgba(r.sign === '+' ? 0x5d8f6b : r.sign === '-' ? 0xa0656c : 0xa8a294)
    const by = top + baseline(ROW_H, FONT_PX)
    const num = (n: number | null, right: number) => {
      if (n === null) return
      const s = String(n)
      write(s, right - 0.6 * ch - s.length * m.advance * NUM_FONT_PX, by, NUM_FONT_PX, numColor)
    }
    num(r.old, noW)
    num(r.new, noW * 2)
    if (r.sign !== ' ') write(r.sign === '-' ? '−' : '+', noW * 2 + 0.5 * ch, by, FONT_PX, rgba(r.sign === '+' ? 0x2f7a3c : 0xb03a46))
    const fade = r.sign === '-' ? 0.85 : 1
    const plain = r.sign === ' ' ? 0x4a463e : COLORS.plain
    lines.forEach((line, i) => {
      let x = i === 0 ? firstX : contX
      const ly = top + i * ROW_H + baseline(ROW_H, FONT_PX)
      for (const { c, kind } of line) {
        const cp = c.codePointAt(0)!
        if (cp !== 32) out.glyph(x, ly, FONT_PX, glyphOf(cp), rgba(kind === 'plain' ? plain : COLORS[kind], fade))
        x += ch
      }
    })
    return top + h
  }

  function head(it: Extract<Item, { kind: 'head' }>, top: number): number {
    out.rect(0, top, width, HEAD_H, rgba(0xeef1f8))
    out.rect(0, top, width, 1, rgba(0xdde3ef))
    out.rect(0, top + HEAD_H - 1, width, 1, rgba(0xdde3ef))
    const by = top + baseline(HEAD_H, FONT_PX)
    const x = write(it.s.range, 8, by, NUM_FONT_PX, rgba(0x8a94ab))
    if (it.s.header) {
      // One line: cut at the edge.
      const room = Math.max(0, Math.floor((width - PAD_RIGHT - x - 1.5 * ch) / ch))
      const text = it.s.header.length > room ? it.s.header.slice(0, Math.max(0, room - 1)) + '…' : it.s.header
      write(text, x + 1.5 * ch, by, FONT_PX, rgba(0x5b6b8c))
    }
    return top + HEAD_H
  }

  function bar(it: Extract<Item, { kind: 'bar' }>, top: number): number {
    const g = it.g
    out.rect(0, top, width, BAR_H, rgba(0xf4f2ec))
    const hidden = g.to - g.from + 1 - g.top - g.bottom
    const by = top + baseline(BAR_H, BAR_FONT_PX)
    const adv = m.advance * BAR_FONT_PX
    let x = 8
    const button = (label: string, action: GapAction) => {
      const w = label.length * adv + 14
      const y0 = top + 2
      const y1 = top + BAR_H - 2
      out.rect(x, y0, w, y1 - y0, rgba(0xddd7ca))
      out.rect(x + 1, y0 + 1, w - 2, y1 - y0 - 2, rgba(0xffffff))
      write(label, x + 7, by, BAR_FONT_PX, rgba(0x1f6feb))
      buttons.push({ gap: it.index, action, x0: x, x1: x + w, y0, y1 })
      x += w + 6
    }
    // Down from the hunk above, up from the hunk below: whichever makes sense where the gap is.
    const STEP = settings.expandLines
    if (hidden <= STEP) button(`Show ${hidden} line${hidden === 1 ? '' : 's'}`, 'all')
    else {
      if (g.where !== 'start') button(`↓ ${STEP}`, 'down')
      if (g.where !== 'end') button(`↑ ${STEP}`, 'up')
      button(`All ${hidden}`, 'all')
    }
    write(`${hidden} unchanged line${hidden === 1 ? '' : 's'}`, x + 4, by, BAR_FONT_PX, rgba(0x7a7568))
    return top + BAR_H
  }

  return { glyphs: out.g, glyphCount: out.gn, rects: out.r, rectCount: out.rn, height: y, width, buttons }
}

/** Applies a gap bar's button to the model. */
export function expandGap(model: DiffModel, gap: number, action: GapAction): void {
  const g = model.gaps[gap]
  if (!g) return
  const hidden = g.to - g.from + 1 - g.top - g.bottom
  const STEP = settings.expandLines
  if (action === 'down') g.top += Math.min(STEP, hidden)
  else if (action === 'up') g.bottom += Math.min(STEP, hidden)
  else g.top += hidden
}
