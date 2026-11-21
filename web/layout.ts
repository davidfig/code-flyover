// Builds the map: module → folder → file, laid out as a squarified treemap.
// The layout depends only on the repo's structure and file sizes, so it stays
// put from one branch to the next (the map is the landmark; changes are overlays).

import type { Analysis } from '../shared/types.ts'

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
  changed: number
  add: number
  del: number
}

export const WORLD_W = 1600
export const WORLD_H = 1000

export function buildMap(a: Analysis): { root: MapNode; nodes: MapNode[]; fileNodes: MapNode[]; byPath: Map<string, MapNode> } {
  const nodes: MapNode[] = []
  const make = (kind: NodeKind, name: string, path: string, module: string, parent: MapNode | null): MapNode => {
    const n: MapNode = { id: nodes.length, kind, name, path, module, parent, children: [], weight: 0, depth: parent ? parent.depth + 1 : 0, x: 0, y: 0, w: 0, h: 0, changed: 0, add: 0, del: 0 }
    nodes.push(n)
    parent?.children.push(n)
    return n
  }
  const root = make('root', a.repo, '', '', null)
  const modules = new Map<string, MapNode>()
  for (const m of a.model.modules) modules.set(m.id, make('module', m.label, m.paths[0].replace(/\/$/, ''), m.id, root))

  const fileNodes: MapNode[] = []
  a.files.forEach((f, i) => {
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
    if (f.status !== 'unchanged') { n.changed = 1; n.add = f.add; n.del = f.del }
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
  // Drop modules with no files, then recount ids/depths.
  root.children = root.children.filter((m) => m.children.length > 0)

  const total = (n: MapNode): number => {
    if (n.kind === 'file') return n.weight
    n.weight = 0
    n.changed = n.add = n.del = 0
    for (const c of n.children) {
      n.weight += total(c)
      n.changed += c.changed
      n.add += c.add
      n.del += c.del
    }
    return n.weight
  }
  total(root)

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
  root.w = WORLD_W
  root.h = WORLD_H
  layout(root)

  const byPath = new Map<string, MapNode>()
  for (const n of live) if (n.kind !== 'root' && !byPath.has(n.path)) byPath.set(n.path, n)
  for (const n of live) if (n.kind === 'module') byPath.set('module:' + n.module, n)
  return { root, nodes: live, fileNodes, byPath }
}

function layout(n: MapNode) {
  if (n.kind === 'file' || n.children.length === 0) return
  const s = Math.min(n.w, n.h)
  const pad = n.kind === 'root' ? 8 : s * 0.025
  const band = n.kind === 'root' ? 0 : Math.min(s * 0.12, n.kind === 'module' ? 26 : 18 * Math.min(1, s / 60))
  const inner = { x: n.x + pad, y: n.y + pad + band, w: Math.max(n.w - pad * 2, 0.0001), h: Math.max(n.h - pad * 2 - band, 0.0001) }
  n.inner = inner
  squarify(n.children, inner, n.kind === 'root' ? 6 : s * 0.006)
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
  const set = (n: MapNode, x: number, y: number, w: number, h: number) => {
    const g = Math.min(gap, w * 0.15, h * 0.15)
    n.x = x + g / 2
    n.y = y + g / 2
    n.w = Math.max(w - g, 0.0001)
    n.h = Math.max(h - g, 0.0001)
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
