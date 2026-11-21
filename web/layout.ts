// Builds the map: module → folder → file, laid out as a squarified treemap.
// The layout depends only on the repo's structure and file sizes, so it stays
// put from one branch to the next (the map is the landmark; changes are overlays).

import type { Analysis, FileInfo, FileRole } from '../shared/types.ts'
import { BAR_H, HEAD_H, ROW_H } from './text/layout.ts'

/** Analyses written before `role` existed only know about tests. */
export const roleOf = (f: FileInfo): FileRole => f.role ?? (f.test ? 'test' : 'source')

export type NodeKind = 'root' | 'module' | 'dir' | 'file'

export interface MapNode {
  id: number
  kind: NodeKind
  name: string
  /** repo path for dirs and files; module prefix for modules */
  path: string
  module: string
  parent: MapNode | null
  children: MapNode[]
  file?: number
  weight: number
  depth: number
  x: number
  y: number
  w: number
  h: number
  /** where children are laid out (below the label band) */
  inner?: { x: number; y: number; w: number; h: number }
  /** changed source files (the footprint) */
  changed: number
  /** changed tests, translations and generated files (muted on the map) */
  other: number
  add: number
  del: number
}

export const WORLD_W = 1600
export const WORLD_H = 1000

/**
 * `hide`: file roles to leave off the map entirely (they take no space and draw no arrows).
 * `only`: when given, the only files on the map (indexes into a.files).
 */
export function buildMap(
  a: Analysis,
  hide: ReadonlySet<FileRole> = new Set(),
  only?: ReadonlySet<number>,
  /** the map's window in CSS px: the column layout takes its shape */
  view?: { width: number; height: number },
): { root: MapNode; nodes: MapNode[]; fileNodes: MapNode[]; byPath: Map<string, MapNode> } {
  const nodes: MapNode[] = []
  const make = (kind: NodeKind, name: string, path: string, module: string, parent: MapNode | null): MapNode => {
    const n: MapNode = { id: nodes.length, kind, name, path, module, parent, children: [], weight: 0, depth: parent ? parent.depth + 1 : 0, x: 0, y: 0, w: 0, h: 0, changed: 0, other: 0, add: 0, del: 0 }
    nodes.push(n)
    parent?.children.push(n)
    return n
  }
  const root = make('root', a.repo, '', '', null)
  const modules = new Map<string, MapNode>()
  for (const m of a.model.modules) modules.set(m.id, make('module', m.label, m.paths[0].replace(/\/$/, ''), m.id, root))

  const fileNodes: MapNode[] = []
  a.files.forEach((f, i) => {
    if (hide.has(roleOf(f)) || (only && !only.has(i))) return
    const mod = modules.get(f.module)!
    const def = a.model.modules.find((m) => m.id === f.module)!
    const prefix = def.paths.find((p) => f.path.startsWith(p)) ?? ''
    const parts = f.path.slice(prefix.length).split('/')
    let cur = mod
    let curPath = prefix.replace(/\/$/, '')
    for (const part of parts.slice(0, -1)) {
      curPath = curPath ? curPath + '/' + part : part
      let next = cur.children.find((c) => c.kind === 'dir' && c.name === part)
      if (!next) next = make('dir', part, curPath, f.module, cur)
      cur = next
    }
    const n = make('file', parts[parts.length - 1], f.path, f.module, cur)
    n.file = i
    n.weight = Math.sqrt(Math.max(f.lines, 1)) + 3
    if (f.status !== 'unchanged') {
      if (roleOf(f) === 'source') n.changed = 1
      else n.other = 1
      n.add = f.add
      n.del = f.del
    }
    fileNodes.push(n)
  })

  // Collapse folder chains with a single child folder: "src" › "lib" → "src/lib".
  const collapse = (n: MapNode) => {
    for (const c of n.children) collapse(c)
    if (n.kind === 'dir' && n.children.length === 1 && n.children[0].kind === 'dir') {
      const only = n.children[0]
      n.name = n.name + '/' + only.name
      n.path = only.path
      n.children = only.children
      for (const c of n.children) c.parent = n
      only.parent = null
    }
  }
  collapse(root)
  // A module whose files all sit in one folder (server/src) is that folder: fold it in, so there's one box and
  // one label for the level, not two.
  for (const m of root.children) {
    if (m.children.length !== 1 || m.children[0].kind !== 'dir') continue
    const only = m.children[0]
    m.children = only.children
    for (const c of m.children) c.parent = m
    only.parent = null
  }
  // Drop modules with no files, then recount ids/depths.
  root.children = root.children.filter((m) => m.children.length > 0)

  const total = (n: MapNode): number => {
    if (n.kind === 'file') return n.weight
    n.weight = 0
    n.changed = n.other = n.add = n.del = 0
    for (const c of n.children) {
      n.weight += total(c)
      n.changed += c.changed
      n.other += c.other
      n.add += c.add
      n.del += c.del
    }
    return n.weight
  }
  total(root)
  // A top-level module gets at least a small share of the map, so a module with one file on it is a box you can
  // see and label, not a sliver its gap would swallow. (Only the top level: inside a module, size is information.)
  const floor = root.weight * 0.03
  for (const m of root.children) m.weight = Math.max(m.weight, floor)

  const live: MapNode[] = []
  const walk = (n: MapNode, depth: number) => {
    n.depth = depth
    live.push(n)
    n.children.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    for (const c of n.children) walk(c, depth + 1)
  }
  walk(root, 0)

  root.x = 0
  root.y = 0
  if (only) {
    // The changed-files view: files as equal-width columns, sized to their diffs (see layoutColumns). No room is kept
    // for labels: they float over the boxes as tags (see drawLabels in map.ts), so boxes hold only their files.
    const aspect = view && view.width > 0 && view.height > 0 ? view.width / view.height : ASPECT
    layoutColumns(root, a, aspect)
  } else {
    root.w = WORLD_W
    root.h = WORLD_H
    layout(root)
  }

  const byPath = new Map<string, MapNode>()
  for (const n of live) if (n.kind !== 'root' && !byPath.has(n.path)) byPath.set(n.path, n)
  for (const n of live) if (n.kind === 'module') byPath.set('module:' + n.module, n)
  return { root, nodes: live, fileNodes, byPath }
}

function layout(n: MapNode) {
  if (n.kind === 'file' || n.children.length === 0) return
  const s = Math.min(n.w, n.h)
  const pad = n.kind === 'root' ? 8 : s * 0.025
  const band = 0 // labels float over the boxes (see drawLabels in map.ts): no strip kept for them
  const inner = { x: n.x + pad, y: n.y + pad + band, w: Math.max(n.w - pad * 2, 0.0001), h: Math.max(n.h - pad * 2 - band, 0.0001) }
  n.inner = inner
  // Top-level modules get a clear gap (about 7px at the whole-map view); folders and files a hairline.
  squarify(n.children, inner, n.kind === 'root' ? 22 : s * 0.006)
  for (const c of n.children) layout(c)
}

/** Squarified treemap (Bruls, Huizing & van Wijk 2000) with a small gap between cells. */
function squarify(items: MapNode[], r: { x: number; y: number; w: number; h: number }, gap: number) {
  const total = items.reduce((s, i) => s + i.weight, 0)
  if (total <= 0) return
  const scale = (r.w * r.h) / total
  let x = r.x
  let y = r.y
  let w = r.w
  let h = r.h
  let row: MapNode[] = []
  const worst = (row: MapNode[], side: number) => {
    const sum = row.reduce((s, i) => s + i.weight * scale, 0)
    let max = 0
    let min = Infinity
    for (const i of row) {
      const a = i.weight * scale
      max = Math.max(max, a)
      min = Math.min(min, a)
    }
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
  }
  const place = (row: MapNode[]) => {
    const sum = row.reduce((s, i) => s + i.weight * scale, 0)
    if (w >= h) {
      const cw = sum / h
      let cy = y
      for (const i of row) {
        const ch = (i.weight * scale) / cw
        set(i, x, cy, cw, ch)
        cy += ch
      }
      x += cw
      w -= cw
    } else {
      const rh = sum / w
      let cx = x
      for (const i of row) {
        const cw = (i.weight * scale) / rh
        set(i, cx, y, cw, rh)
        cx += cw
      }
      y += rh
      h -= rh
    }
  }
  // Every box shrinks by the same gap inside its cell, so edges line up and the level keeps one outline. A cell
  // too small for the whole gap keeps half its size, centred: it shrinks inward, never out past its neighbours.
  const set = (n: MapNode, x: number, y: number, w: number, h: number) => {
    const nw = Math.max(w - gap, w * 0.5)
    const nh = Math.max(h - gap, h * 0.5)
    n.x = x + (w - nw) / 2
    n.y = y + (h - nh) / 2
    n.w = Math.max(nw, 0.0001)
    n.h = Math.max(nh, 0.0001)
  }
  for (const item of items) {
    const side = Math.min(w, h)
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) row.push(item)
    else {
      place(row)
      row = [item]
    }
  }
  if (row.length) place(row)
}

// ---------- the column layout (the changed-files view) ----------
//
// With only the touched files on the map, the point is reading them, and a treemap's thin boxes are bad for text.
// Here every file is a column of the same width (COL_W world units, one text pixel each at text scale 1), as tall
// as its diff (floored and capped), so one text size reads well in every box. A folder lays its own files out in
// balanced columns (each file into the shortest one), and packs those with its sub-folders in rows; modules are
// packed the same way at the top. Box size here says how much changed, not how big the file is.

/**
 * A file column's width: 100 characters of 12px code (7.2px each) after the line-number gutter (11.5 characters) and
 * the right margin (8px), so lines up to 100 characters don't wrap. The map's text scale is 1 when this is DIFF_W px
 * on screen (web/map.ts).
 */
export const COL_W = 812
const PAD = 14
const GAP = 16
const ROOT_GAP = 48
/** The shape folders and the whole map aim for (width / height). */
const ASPECT = 1.6
/** A file with no diff (an import's other end): just room for its tag. */
const NO_DIFF_H = 140
/** The shortest file box with a diff, so a one-line change still has a box you can see and label. */
const MIN_H = 120
/** The tallest a file box gets from its diff alone; a longer diff scrolls inside it (select the file, then scroll). */
const MAX_H = 1800
/**
 * Characters of code on a row at COL_W before it wraps, on its first visual line and on continuations: the same sums
 * as text/layout.ts (12px monospace, 7.2px a character, after the number gutters, minus the right margin).
 */
const PER_FIRST = 99
const PER_CONT = 97

/** How many visual rows a line of code takes at COL_W (wrapped as text/layout.ts wraps it, near enough). */
const visualRows = (s: string): number => {
  const n = s.replace(/\t/g, '  ').length
  return n <= PER_FIRST ? 1 : 1 + Math.ceil((n - PER_FIRST) / PER_CONT)
}

/**
 * How tall a file's text is at COL_W, in the same text px the map draws it at (so box and text match):
 * `shown`, its diff as first drawn (hunk headers, rows, a bar for each run of hidden lines); `full`, with every
 * hidden line shown (what filling a taller box can grow to).
 */
function fileText(f: FileInfo): { shown: number; full: number } {
  if (!f.hunks?.length) return { shown: NO_DIFF_H, full: NO_DIFF_H }
  const fileLines = f.text?.split('\n') ?? null
  if (fileLines && fileLines[fileLines.length - 1] === '') fileLines.pop()
  const deleted = f.status === 'deleted'
  let shown = 0
  let hidden = 0
  let prevEnd = 0
  const gap = (from: number, to: number) => {
    if (!fileLines || to < from) return
    shown += BAR_H
    for (let no = from; no <= to; no++) hidden += visualRows(fileLines[no - 1] ?? '') * ROW_H
  }
  for (const h of f.hunks) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(h.header)
    const start = m ? Number(deleted ? m[1] : m[2]) : prevEnd + 1
    gap(prevEnd + 1, start - 1)
    shown += HEAD_H
    let count = 0
    for (const l of h.lines) {
      shown += visualRows(l.s) * ROW_H
      if (l.t !== (deleted ? '+' : '-')) count++
    }
    prevEnd = Math.max(prevEnd, start + count - 1)
  }
  if (fileLines) gap(prevEnd + 1, fileLines.length)
  // Every hidden line shown: its rows in, its bars out.
  const bars = shown - f.hunks.reduce((t, h) => t + HEAD_H + h.lines.reduce((u, l) => u + visualRows(l.s) * ROW_H, 0), 0)
  return { shown, full: shown - bars + hidden }
}

/** A file box's height before packing (its text, floored and capped) and the most it can usefully grow to. */
function fileHeight(f: FileInfo): { h: number; max: number } {
  if (!f.hunks?.length) return { h: NO_DIFF_H, max: NO_DIFF_H }
  const t = fileText(f)
  const h = Math.min(MAX_H, Math.max(MIN_H, t.shown))
  return { h, max: Math.max(h, t.full) }
}

/**
 * Shares `room` (a column's height, gaps taken out) among its files: each starts at its natural height and takes a
 * share of the extra in proportion to it, but never past what it has to show (see fileHeight). What none of them can
 * use is left empty at the column's foot, so no box is taller than its text.
 */
function shareColumn(nat: number[], max: number[], room: number): number[] {
  const h = nat.slice()
  let extra = room - nat.reduce((t, v) => t + v, 0)
  let open = h.map((_, i) => i).filter((i) => max[i] > h[i] + 0.5)
  while (extra > 0.5 && open.length) {
    const weight = open.reduce((t, i) => t + nat[i], 0)
    let used = 0
    for (const i of open) {
      const add = Math.min((extra * nat[i]) / weight, max[i] - h[i])
      h[i] += add
      used += add
    }
    extra -= used
    open = open.filter((i) => max[i] > h[i] + 0.5)
    if (used < 0.5) break
  }
  return h
}

interface Block {
  /** its size: natural when packed, then grown into free space below and to the right */
  w: number
  h: number
  place(x: number, y: number): void
}

/**
 * Packs blocks into a width that makes the whole about `aspect` wide: biggest first, each dropped into the lowest
 * spot along the top edge built so far (the skyline) where it fits, leftmost on a tie. Fewer holes than rows.
 * Returns where each block went; nothing is placed yet.
 */
function skyline(blocks: Block[], gap: number, aspect: number): { at: { x: number; y: number }[]; width: number; height: number } {
  const order = blocks.map((b, i) => i).sort((i, j) => blocks[j].h * blocks[j].w - blocks[i].h * blocks[i].w)
  const area = blocks.reduce((t, b) => t + (b.w + gap) * (b.h + gap), 0)
  const target = Math.max(...blocks.map((b) => b.w), Math.sqrt(area * aspect))
  // The skyline: runs of x with the y where the next block could start.
  let sky: { x: number; w: number; y: number }[] = [{ x: 0, w: target + gap, y: 0 }]
  const at: { x: number; y: number }[] = []
  let width = 0
  let height = 0
  for (const i of order) {
    const b = blocks[i]
    const need = b.w + gap
    let best: { x: number; y: number } | null = null
    for (const seg of sky) {
      if (seg.x + need > target + gap + 0.01) continue
      // The block rests on the highest run it would cover.
      let y = 0
      for (const t of sky) if (t.x < seg.x + need && t.x + t.w > seg.x) y = Math.max(y, t.y)
      if (!best || y < best.y - 0.01 || (Math.abs(y - best.y) < 0.01 && seg.x < best.x)) best = { x: seg.x, y }
    }
    const p = best ?? { x: 0, y: Math.max(...sky.map((t) => t.y)) }
    at[i] = p
    width = Math.max(width, p.x + b.w)
    height = Math.max(height, p.y + b.h)
    // Raise the skyline under the block.
    const top = p.y + b.h + gap
    const next: typeof sky = []
    for (const t of sky) {
      const end = t.x + t.w
      if (end <= p.x || t.x >= p.x + need) next.push(t)
      else {
        if (t.x < p.x) next.push({ x: t.x, w: p.x - t.x, y: t.y })
        if (end > p.x + need) next.push({ x: p.x + need, w: end - (p.x + need), y: t.y })
      }
    }
    next.push({ x: p.x, w: need, y: top })
    next.sort((u, v) => u.x - v.x)
    // Merge neighbours at the same height.
    sky = []
    for (const t of next) {
      const last = sky[sky.length - 1]
      if (last && Math.abs(last.y - t.y) < 0.01 && Math.abs(last.x + last.w - t.x) < 0.01) last.w += t.w
      else sky.push({ ...t })
    }
  }
  return { at, width, height }
}

/**
 * `aspect` is the shape (width / height) the whole map aims for: the window's, so it fills the view. Folders aim
 * for ASPECT.
 */
function layoutColumns(root: MapNode, a: Analysis, aspect = ASPECT) {
  /** each child's position relative to its parent's content area */
  const local = new Map<MapNode, { x: number; y: number }>()
  const inset = (n: MapNode) => (n.kind === 'root' ? { x: 0, y: 0 } : { x: PAD, y: PAD })
  const natural = new Map<MapNode, number>()
  /** the tallest a file's box can be before it would run out of text to show (see fileHeight) */
  const most = new Map<MapNode, number>()
  /** how much there is to read under a node: its files' column area at their natural heights */
  const contentOf = (n: MapNode): number => (n.kind === 'file' ? COL_W * (natural.get(n) ?? 0) : n.children.reduce((t, c) => t + contentOf(c), 0))
  /** a module's chosen shape, kept so laying out its parent (or growing it) doesn't reset it */
  const shapeOf = new Map<MapNode, number>()

  /**
   * Lays out `n`'s contents, aiming for `shape` (width / height). With `forcedH` or `forcedW` its contents are
   * stretched to fill that size (the space around it was free).
   */
  const size = (n: MapNode, forcedH?: number, shape = ASPECT, forcedW?: number): void => {
    if (n.kind === 'file') {
      const fh = fileHeight(a.files[n.file!])
      n.w = COL_W
      n.h = fh.h
      natural.set(n, fh.h)
      most.set(n, fh.max)
      return
    }
    const gap = n.kind === 'root' ? ROOT_GAP : GAP
    const files = n.children.filter((c) => c.kind === 'file').sort((x, y) => x.path.localeCompare(y.path))
    const groups = n.children.filter((c) => c.kind !== 'file')
    const blocks: Block[] = []
    if (files.length) {
      for (const f of files) size(f)
      // Balanced columns: enough of them to make the block about the folder's shape (or, if the folder was given
      // a size, as many as fit across it), each file into the shortest.
      const total = files.reduce((t, f) => t + f.h + GAP, 0)
      const fit = forcedW !== undefined && groups.length === 0 ? Math.floor((forcedW - inset(n).x * 2 + GAP) / (COL_W + GAP)) : 0
      const count = Math.max(1, Math.min(files.length, fit || Math.round(Math.sqrt((Math.min(shape, 8) * total) / COL_W))))
      /** files into `k` balanced columns, each into the shortest so far */
      const balance = (k: number) => {
        const cols: MapNode[][] = Array.from({ length: k }, () => [])
        const heights = new Array<number>(k).fill(0)
        for (const f of files) {
          const c = heights.indexOf(Math.min(...heights))
          cols[c].push(f)
          heights[c] += natural.get(f)! + GAP
        }
        return { cols, height: Math.max(...heights) - GAP }
      }
      const packedCols = balance(count)
      const block: Block = {
        w: count * COL_W + (count - 1) * GAP,
        h: packedCols.height,
        // Grown wider than its columns (to fill a hole beside it): more columns where whole ones fit, so no column is
        // much wider than its code. Every column shares the block's width, and its files share the block's height up
        // to what they have to show (shareColumn); what's left over stays empty at the column's foot.
        place: (x, y) => {
          const k = Math.max(1, Math.min(files.length, Math.floor((block.w + GAP + 0.5) / (COL_W + GAP))))
          const { cols } = k === count ? packedCols : balance(k)
          const colW = (block.w - (k - 1) * GAP) / k
          cols.forEach((col, c) => {
            const hs = shareColumn(col.map((f) => natural.get(f)!), col.map((f) => most.get(f)!), block.h - GAP * (col.length - 1))
            let yy = y
            col.forEach((f, i) => {
              f.w = colW
              f.h = hs[i]
              local.set(f, { x: x + c * (colW + GAP), y: yy })
              yy += f.h + GAP
            })
          })
        },
      }
      blocks.push(block)
    }
    for (const g of groups) {
      size(g, undefined, shapeOf.get(g))
      const nat = { w: g.w, h: g.h }
      const block: Block = {
        w: g.w,
        h: g.h,
        place: (x, y) => {
          // Grown: lay it out again at its new size, so its own contents fill it too.
          // Re-arranged for its new shape (so a narrow, tall box gets fewer, longer columns, not stretched bars),
          // unless that doesn't fit in the space it was given: then the arrangement it packed with, which does.
          if (Math.abs(block.w - nat.w) > 0.5 || Math.abs(block.h - nat.h) > 0.5) {
            size(g, block.h, block.w / block.h, block.w)
            if (g.w > block.w + 0.5 || g.h > block.h + 0.5) size(g, block.h, shapeOf.get(g), block.w)
          }
          local.set(g, { x, y })
        },
      }
      blocks.push(block)
    }
    const packed = skyline(blocks, gap, shape)
    const packedW = blocks.map((b) => b.w)
    const i = inset(n)
    const bottom = n.kind === 'root' ? 0 : PAD
    const contentH = forcedH !== undefined ? Math.max(forcedH - i.y - bottom, packed.height) : packed.height
    const contentW = forcedW !== undefined ? Math.max(forcedW - i.x * 2, packed.width) : packed.width
    const at = packed.at
    // When the box is bigger than its packed contents (stretched to fill its parent or the window), spread the
    // extra over every block in proportion to its size, keeping the gaps: so no one block at the edge soaks it all
    // up. Scaling every position and size alike can't make blocks overlap.
    const fw = (contentW + gap) / (packed.width + gap)
    const fh = (contentH + gap) / (packed.height + gap)
    if (fw > 1.0001 || fh > 1.0001) {
      blocks.forEach((b, k) => {
        at[k] = { x: at[k].x * fw, y: at[k].y * fh }
        b.w = (b.w + gap) * fw - gap
        b.h = (b.h + gap) * fh - gap
      })
    }
    // Modules side by side in one row share the width by how much changed in each (the area of their files'
    // columns), not by how they happened to pack: the busier module gets the room. None goes narrower than its
    // packed width, and what that leaves is shared among the rest the same way.
    if (n.kind === 'root' && blocks.length > 1 && blocks.length === groups.length && at.every((p) => Math.abs(p.y) < 0.01)) {
      const content = groups.map((g) => contentOf(g))
      const order = blocks.map((_, k) => k).sort((p, q) => at[p].x - at[q].x)
      const minW = blocks.map((b, k) => packedW[k])
      const room = contentW + gap
      let free = order.slice()
      const width = new Array<number>(blocks.length).fill(0)
      for (let pass = 0; pass < blocks.length; pass++) {
        const fixed = order.filter((k) => !free.includes(k)).reduce((t, k) => t + width[k] + gap, 0)
        const share = free.reduce((t, k) => t + content[k], 0)
        let changed = false
        for (const k of free) width[k] = ((room - fixed) * content[k]) / share - gap
        for (const k of free) if (width[k] < minW[k]) { width[k] = minW[k]; free = free.filter((j) => j !== k); changed = true }
        if (!changed) break
      }
      let x = 0
      for (const k of order) {
        at[k] = { x, y: 0 }
        blocks[k].w = width[k]
        x += width[k] + gap
      }
    }
    // Packing leaves holes: a row that doesn't reach the right edge, a block shorter than its neighbours. Each block
    // grows right, then down, into free space up to the next block or the edge, so the folder's background doesn't
    // show through. A file only grows as far as it has text to show (shareColumn) and a wider file block gains columns,
    // so this doesn't make tall empty boxes; folders lay themselves out again at the new size.
    const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - 0.01 && b0 < a1 - 0.01
    const byRight = blocks.map((_, k) => k).sort((p, q) => at[q].x + blocks[q].w - (at[p].x + blocks[p].w))
    for (const k of byRight) {
      const b = blocks[k]
      let limit = contentW
      blocks.forEach((o, j) => {
        if (j !== k && at[j].x >= at[k].x + b.w - 0.01 && overlaps(at[k].y, at[k].y + b.h, at[j].y, at[j].y + o.h)) limit = Math.min(limit, at[j].x - gap)
      })
      b.w = Math.max(b.w, limit - at[k].x)
    }
    const byBottom = blocks.map((_, k) => k).sort((p, q) => at[q].y + blocks[q].h - (at[p].y + blocks[p].h))
    for (const k of byBottom) {
      const b = blocks[k]
      let limit = contentH
      blocks.forEach((o, j) => {
        if (j !== k && at[j].y >= at[k].y + b.h - 0.01 && overlaps(at[k].x, at[k].x + b.w, at[j].x, at[j].x + o.w)) limit = Math.min(limit, at[j].y - gap)
      })
      b.h = Math.max(b.h, limit - at[k].y)
    }
    blocks.forEach((b, k) => b.place(at[k].x, at[k].y))
    n.w = contentW + i.x * 2
    n.h = contentH + i.y + bottom
  }
  // The top level aims for the window. With a few modules of very different sizes, packing alone often can't get
  // there (a big module and a small one stack, whatever the window). So try two arrangements and keep the one that
  // covers more of the window with files at the whole-map view: (A) modules at their own shape, packed; (B) modules
  // in one row, each shaped by its share of the total area so the row comes out the window's shape.
  const filesArea = (n: MapNode): number => (n.kind === 'file' ? n.w * n.h : n.children.reduce((t, c) => t + filesArea(c), 0))
  const covered = () => {
    const shape = root.w / root.h
    return (filesArea(root) / (root.w * root.h)) * Math.min(shape / aspect, aspect / shape)
  }
  // (C) is the biggest module at the window's shape and the rest packed around it, for one module that dominates.
  type Plan = { shapes: Map<MapNode, number>; rootShape: number }
  const plans: Plan[] = [{ shapes: new Map(), rootShape: aspect }]
  for (const m of root.children) size(m)
  const total = root.children.reduce((t, m) => t + m.w * m.h, 0)
  if (root.children.length > 1 && total > 0) {
    plans.push({ shapes: new Map(root.children.map((m) => [m, Math.max(0.25, (aspect * m.w * m.h) / total)])), rootShape: Infinity })
    const biggest = root.children.reduce((x, y) => (y.w * y.h > x.w * x.h ? y : x))
    plans.push({ shapes: new Map([[biggest, aspect]]), rootShape: aspect })
  }
  const apply = (p: Plan) => {
    shapeOf.clear()
    for (const [m, v] of p.shapes) shapeOf.set(m, v)
    size(root, undefined, p.rootShape)
    return covered()
  }
  let best = plans[0]
  let bestCover = -1
  for (const p of plans) {
    const c = apply(p)
    if (c > bestCover) { best = p; bestCover = c }
  }
  apply(best)
  // Then stretch the whole map to the window's shape, so nothing around it is blank either.
  if (root.w / root.h < aspect) size(root, undefined, best.rootShape, root.h * aspect)
  else size(root, root.w / aspect, best.rootShape)

  const place = (n: MapNode, x: number, y: number) => {
    n.x = x
    n.y = y
    const i = inset(n)
    for (const c of n.children) {
      const p = local.get(c)!
      place(c, x + i.x + p.x, y + i.y + p.y)
    }
  }
  place(root, 0, 0)
}
