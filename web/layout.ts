// Builds the map: module → folder → file, laid out as a squarified treemap.
// The layout depends only on the repo's structure and file sizes, so it stays
// put from one branch to the next (the map is the landmark; changes are overlays).

import type { Analysis, FileInfo, FileRole } from '../shared/types.ts'
import { BAR_H, HEAD_H, ROW_H } from './text/layout.ts'
import { colW, settings, tabSpaces } from './settings.ts'

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

/**
 * Every file on the map in reading order: a group at a time, its own files together and its folders in turn, going by
 * where they sit (top to bottom, then left to right). Files go down each column; in the treemap, in the order they
 * were placed.
 */
export function readingOrder(root: MapNode, columns: boolean): MapNode[] {
  const out: MapNode[] = []
  const near = (p: number, q: number) => Math.abs(p - q) < 0.5
  const walk = (n: MapNode) => {
    const files = n.children.filter((c) => c.kind === 'file')
    if (columns) files.sort((p, q) => (near(p.x, q.x) ? p.y - q.y : p.x - q.x))
    const blocks: { x: number; y: number; visit(): void }[] = n.children.filter((c) => c.kind !== 'file').map((c) => ({ x: c.x, y: c.y, visit: () => walk(c) }))
    if (files.length) blocks.push({ x: Math.min(...files.map((f) => f.x)), y: Math.min(...files.map((f) => f.y)), visit: () => out.push(...files) })
    blocks.sort((p, q) => (near(p.y, q.y) ? p.x - q.x : p.y - q.y))
    for (const b of blocks) b.visit()
  }
  walk(root)
  return out
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
 * A file column's width: the Code width setting's characters of 12px code (7.2px each) after the line-number gutter
 * (11.5 characters) and the right margin (8px), so lines up to that long don't wrap (settings.ts colW). The map's text
 * scale is 1 when this is its width in px on screen (web/map.ts).
 */
const PAD = 14
const GAP = 16
const ROOT_GAP = 48
/** The shape folders and the whole map aim for (width / height). */
const ASPECT = 1.6
/** A file with no diff (an import's other end): just room for its tag. */
const NO_DIFF_H = 140
/** The shortest file box with a diff, so a one-line change still has a box you can see and label. */
const MIN_H = 120
/** The tallest a file box gets from its diff alone (the Tallest file box setting); a longer diff scrolls inside it (select the file, then scroll). */
const maxH = () => Math.round(settings.tallestFileLines * ROW_H)
/**
 * Characters of code on a row at the column width before it wraps, on its first visual line and on continuations
 * (indented 1.5 characters more): the same sums as text/layout.ts.
 */
const perFirst = () => settings.codeColumns - 1
const perCont = () => settings.codeColumns - 3

/** How many visual rows a line of code takes at COL_W (wrapped as text/layout.ts wraps it, near enough). */
const visualRows = (s: string): number => {
  const n = s.replace(/\t/g, tabSpaces()).length
  const first = perFirst()
  return n <= first ? 1 : 1 + Math.ceil((n - first) / perCont())
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
    if (f.status !== 'unchanged') shown += HEAD_H
    let count = 0
    for (const l of h.lines) {
      shown += visualRows(l.s) * ROW_H
      if (l.t !== (deleted ? '+' : '-')) count++
    }
    prevEnd = Math.max(prevEnd, start + count - 1)
  }
  if (fileLines) gap(prevEnd + 1, fileLines.length)
  // Every hidden line shown: its rows in, its bars out.
  const bars = shown - f.hunks.reduce((t, h) => t + (f.status !== 'unchanged' ? HEAD_H : 0) + h.lines.reduce((u, l) => u + visualRows(l.s) * ROW_H, 0), 0)
  return { shown, full: shown - bars + hidden }
}

/** A file box's height before packing (its text, floored and capped) and the most it can usefully grow to. */
function fileHeight(f: FileInfo): { h: number; max: number } {
  if (!f.hunks?.length) return { h: NO_DIFF_H, max: NO_DIFF_H }
  const t = fileText(f)
  const h = Math.min(maxH(), Math.max(MIN_H, t.shown))
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

/** A way to lay something out: the size it takes, and how to put it at a place, filling at least that size. */
interface Variant {
  w: number
  h: number
  place(x: number, y: number, w: number, h: number): void
}

interface Packing {
  w: number
  h: number
  at: { x: number; y: number }[]
  /** which of each block's variants it uses */
  pick: number[]
}

/** The shapes (width / height) a folder is offered in, for its parent to choose from. */
const SHAPES = [0.3, 0.55, 0.9, ASPECT, 2.6, 4.5]
/** Widths to try for a packing, against the one that would make it exactly the shape with no holes. */
const WIDTHS = [0.92, 1, 1.08, 1.18, 1.3]
/** The most the whole map is stretched to take the window's shape. */
const MAX_STRETCH = 1.25
/** Packings tried while improving one arrangement: plenty for the top level, few for each folder below it. */
const TRIES_ROOT = 1500
const TRIES_FOLDER = 60

/**
 * Packs blocks into `target` wide: biggest first, each dropped into the lowest spot along the top edge built so far
 * (the skyline) where it fits, leftmost on a tie. Fewer holes than rows.
 */
function skyline(blocks: { w: number; h: number }[], gap: number, target: number): { at: { x: number; y: number }[]; w: number; h: number } {
  const order = blocks.map((_, i) => i).sort((i, j) => blocks[j].h * blocks[j].w - blocks[i].h * blocks[i].w)
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
      for (const t of sky) if (t.x < seg.x + need - 0.01 && t.x + t.w > seg.x + 0.01) y = Math.max(y, t.y)
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
  return { at, w: width, h: height }
}

/**
 * The tightest packing found of blocks (each in one of its variants) for a window `shape` (width / height): the one
 * that shows largest in such a window. Starts from the blocks all near one shape, at a few widths, then changes one
 * block's variant at a time while that helps.
 */
function tightest(blocks: Variant[][], gap: number, shape: number, tries: number): Packing {
  // What a window of this shape has to be to hold it, so smaller is denser and shows bigger; the area breaks ties.
  const cost = (w: number, h: number) => Math.max(w, h * shape) + (w + h * shape) * 0.02
  let left = tries
  const pack = (pick: number[]): Packing & { cost: number } => {
    const sized = blocks.map((v, i) => v[pick[i]])
    const area = sized.reduce((t, b) => t + (b.w + gap) * (b.h + gap), 0)
    const widest = Math.max(...sized.map((b) => b.w))
    const seen = new Set<number>()
    let best: (Packing & { cost: number }) | null = null
    for (const f of WIDTHS) {
      const target = Math.max(widest, Math.sqrt(area * shape) * f)
      if (seen.has(target)) continue
      seen.add(target)
      left--
      const p = skyline(sized, gap, target)
      const c = cost(p.w, p.h)
      if (!best || c < best.cost) best = { w: p.w, h: p.h, at: p.at, pick, cost: c }
    }
    return best!
  }
  const near = (v: Variant[], s: number) => v.reduce((best, o, i) => (Math.abs(Math.log(o.w / o.h / s)) < Math.abs(Math.log(v[best].w / v[best].h / s)) ? i : best), 0)
  let best: (Packing & { cost: number }) | null = null
  for (const s of [shape, ...SHAPES]) {
    const p = pack(blocks.map((v) => near(v, s)))
    if (!best || p.cost < best.cost) best = p
  }
  // The biggest blocks first: they decide the most.
  const order = blocks.map((_, i) => i).sort((i, j) => blocks[j][0].w * blocks[j][0].h - blocks[i][0].w * blocks[i][0].h)
  for (let improved = true; improved && left > 0; ) {
    improved = false
    for (const i of order) {
      for (let o = 0; o < blocks[i].length && left > 0; o++) {
        if (o === best!.pick[i]) continue
        const p = pack(best!.pick.map((v, j) => (j === i ? o : v)))
        if (p.cost < best!.cost - 0.01) {
          best = p
          improved = true
        }
      }
    }
  }
  return best!
}

/** Drops the variants another beats both ways, and near-duplicates. */
function pareto(all: Variant[]): Variant[] {
  const out: Variant[] = []
  for (const v of all.sort((x, y) => x.w - y.w || x.h - y.h)) if (!out.length || v.h < out[out.length - 1].h * 0.995) out.push(v)
  return out
}

/**
 * Lays the map out for a window `aspect` (width / height): as tightly as it can, so every box is as big as possible
 * with the whole map in view. Bottom up, each folder works out a few shapes it could take; its parent picks among
 * them. Then, top down, what space is left over (holes, the last bit of the window) is shared out.
 */
function layoutColumns(root: MapNode, a: Analysis, aspect = ASPECT) {
  const COL_W = colW()
  const heights = new Map<MapNode, { h: number; max: number }>()
  const set = (n: MapNode, x: number, y: number, w: number, h: number) => {
    n.x = x
    n.y = y
    n.w = w
    n.h = h
  }

  /** A folder's own files, in every number of equal-width columns worth trying. */
  const fileVariants = (files: MapNode[]): Variant[] => {
    for (const f of files) heights.set(f, fileHeight(a.files[f.file!]))
    // Longest first into the shortest column, which balances them best; then each column in path order.
    const longest = [...files].sort((p, q) => heights.get(q)!.h - heights.get(p)!.h || p.path.localeCompare(q.path))
    const balanced = new Map<number, { cols: MapNode[][]; height: number }>()
    const balance = (k: number) => {
      let b = balanced.get(k)
      if (!b) {
        const cols: MapNode[][] = Array.from({ length: k }, () => [])
        const sum = new Array<number>(k).fill(0)
        for (const f of longest) {
          const c = sum.indexOf(Math.min(...sum))
          cols[c].push(f)
          sum[c] += heights.get(f)!.h + GAP
        }
        for (const col of cols) col.sort((p, q) => p.path.localeCompare(q.path))
        cols.sort((p, q) => p[0].path.localeCompare(q[0].path))
        balanced.set(k, (b = { cols, height: Math.max(...sum) - GAP }))
      }
      return b
    }
    const counts = new Set<number>()
    for (let k = 1; k <= files.length; k = k < 12 ? k + 1 : Math.ceil(k * 1.15)) counts.add(k)
    return pareto([...counts].map((k) => ({
      w: k * COL_W + (k - 1) * GAP,
      h: balance(k).height,
      // Given more width than its columns: more of them where whole ones fit, so none is much wider than its code.
      // Every column shares the width, and its files share the height up to what they have to show (shareColumn);
      // what's left over stays empty at the column's foot.
      place: (x, y, w, h) => {
        const n = Math.max(k, Math.min(files.length, Math.floor((w + GAP + 0.5) / (COL_W + GAP))))
        const { cols } = balance(n)
        const cw = (w - (n - 1) * GAP) / n
        cols.forEach((col, c) => {
          const hs = shareColumn(col.map((f) => heights.get(f)!.h), col.map((f) => heights.get(f)!.max), h - GAP * (col.length - 1))
          let yy = y
          col.forEach((f, i) => {
            set(f, x + c * (cw + GAP), yy, cw, hs[i])
            yy += hs[i] + GAP
          })
        })
      },
    })))
  }

  /** The blocks a module or folder is made of: its own files, and each folder in it. */
  const blocksOf = (n: MapNode): Variant[][] => {
    const files = n.children.filter((c) => c.kind === 'file')
    const blocks = n.children.filter((c) => c.kind !== 'file').map(variants)
    if (files.length) blocks.push(fileVariants(files))
    return blocks
  }

  const variants = (n: MapNode): Variant[] => {
    const blocks = blocksOf(n)
    const inset = (w: number, h: number, put: (x: number, y: number, w: number, h: number) => void): Variant => ({
      w: w + PAD * 2,
      h: h + PAD * 2,
      place: (x, y, ow, oh) => {
        set(n, x, y, ow, oh)
        put(x + PAD, y + PAD, ow - PAD * 2, oh - PAD * 2)
      },
    })
    if (blocks.length === 1) return fitting(blocks[0].map((v) => inset(v.w, v.h, v.place)))
    return fitting(pareto(SHAPES.map((s) => {
      const p = tightest(blocks, GAP, s, TRIES_FOLDER)
      return inset(p.w, p.h, (x, y, w, h) => spread(blocks, p, GAP, x, y, w, h))
    })))
  }

  /** Variants that, given more room than they need, give way to whichever of them fills that room best. */
  const fitting = (all: Variant[]): Variant[] =>
    all.map((v) => ({
      w: v.w,
      h: v.h,
      place: (x, y, w, h) => {
        let best = v
        for (const o of all) if (o.w <= w + 0.5 && o.h <= h + 0.5 && Math.min(o.w / w, o.h / h) > Math.min(best.w / w, best.h / h)) best = o
        best.place(x, y, w, h)
      },
    }))

  /** Places a packing in a box at least its size, sharing the spare room out so little is left blank. */
  const spread = (blocks: Variant[][], p: Packing, gap: number, x: number, y: number, w: number, h: number) => {
    // Every block takes its part of the extra, in proportion to its size, keeping the gaps: so no one block at the
    // edge soaks it all up. Scaling every position and size alike can't make blocks overlap.
    const fw = (w + gap) / (p.w + gap)
    const fh = (h + gap) / (p.h + gap)
    const box = blocks.map((v, i) => {
      const b = v[p.pick[i]]
      return { x: p.at[i].x * fw, y: p.at[i].y * fh, w: (b.w + gap) * fw - gap, h: (b.h + gap) * fh - gap }
    })
    // Packing leaves holes: a row that doesn't reach the right edge, a block shorter than its neighbours. Each block
    // grows down, then right, up to the next block or the edge. (Down first: a taller file shows more of itself, a
    // wider one mostly more blank.)
    const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - 0.01 && b0 < a1 - 0.01
    for (const b of [...box].sort((s, t) => t.y + t.h - (s.y + s.h))) {
      let limit = h
      for (const o of box) if (o !== b && o.y >= b.y + b.h - 0.01 && overlaps(b.x, b.x + b.w, o.x, o.x + o.w)) limit = Math.min(limit, o.y - gap)
      b.h = Math.max(b.h, limit - b.y)
    }
    for (const b of [...box].sort((s, t) => t.x + t.w - (s.x + s.w))) {
      let limit = w
      for (const o of box) if (o !== b && o.x >= b.x + b.w - 0.01 && overlaps(b.y, b.y + b.h, o.y, o.y + o.h)) limit = Math.min(limit, o.x - gap)
      b.w = Math.max(b.w, limit - b.x)
    }
    box.forEach((b, i) => blocks[i][p.pick[i]].place(x + b.x, y + b.y, b.w, b.h))
  }

  const blocks = blocksOf(root)
  if (!blocks.length) {
    set(root, 0, 0, WORLD_W, WORLD_H)
    return
  }
  const p = tightest(blocks, ROOT_GAP, aspect, TRIES_ROOT)
  // The whole map takes the window's shape, so nothing around it is blank either; but only so far, or a few files on
  // a wide screen would be mostly blank boxes.
  set(root, 0, 0, Math.min(Math.max(p.w, p.h * aspect), p.w * MAX_STRETCH), Math.min(Math.max(p.h, p.w / aspect), p.h * MAX_STRETCH))
  spread(blocks, p, ROOT_GAP, 0, 0, root.w, root.h)
}
