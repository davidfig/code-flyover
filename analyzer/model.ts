// The intended architecture: the repo's own .semantic-zoom.json (read from the base commit, so a branch can't loosen
// the rules it's checked against), else models/<repo>.json here, else inferred from the repo's layout (workspace
// folders and top-level folders).

import fs from 'node:fs'
import path from 'node:path'
import type { ArchitectureModel, ModuleDef } from '../shared/types.ts'

export interface ModelFile {
  name: string
  source: string
  modules: { id: string; label?: string; paths: string[]; description?: string }[]
  allowed?: Record<string, string[]>
  /** modules whose source (not tests) may not import third-party packages */
  noThirdParty?: string[]
  rules?: string[]
}

export interface LoadedModel {
  model: ArchitectureModel
  noThirdParty: Set<string>
}

const GROUP_DIRS = new Set(['crates', 'packages', 'apps', 'libs', 'services'])

/** The architecture model's file name at an analyzed repo's root. */
export const REPO_MODEL_FILE = '.semantic-zoom.json'

/** `repoModel`: the text of the repo's own REPO_MODEL_FILE at the base commit, if it has one. */
export function loadModel(modelsDir: string, repoName: string, files: string[], repoModel?: string): LoadedModel {
  const file = path.join(modelsDir, `${repoName}.json`)
  const modules: ModuleDef[] = []
  let model: ArchitectureModel
  let noThirdParty = new Set<string>()
  const text = repoModel ?? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined)
  if (text !== undefined) {
    const m = JSON.parse(text) as ModelFile
    for (const mod of m.modules) {
      modules.push({ id: mod.id, label: mod.label ?? mod.id, paths: mod.paths, description: mod.description, modeled: true })
    }
    model = { name: m.name, source: m.source, kind: 'intended', modules, allowed: m.allowed ?? {}, rules: m.rules ?? [] }
    noThirdParty = new Set(m.noThirdParty ?? [])
  } else {
    model = {
      name: 'Inferred from folders',
      source: `inferred: no ${REPO_MODEL_FILE} in the repo (or models/${repoName}.json here), so the base branch’s dependencies count as the intended ones`,
      kind: 'inferred',
      modules,
      allowed: {},
      rules: [],
    }
  }
  // Every file needs a module: add implicit ones for folders the model doesn't cover.
  for (const f of files) {
    if (moduleOf(model, f)) continue
    const parts = f.split('/')
    const prefix = parts.length === 1 ? '' : GROUP_DIRS.has(parts[0]) && parts.length > 2 ? parts.slice(0, 2).join('/') + '/' : parts[0] + '/'
    const id = prefix ? prefix.slice(0, -1) : '(root)'
    if (!modules.some((m) => m.id === id)) modules.push({ id, label: id, paths: [prefix], modeled: false })
  }
  return { model, noThirdParty }
}

export function moduleOf(model: ArchitectureModel, file: string): string | undefined {
  let best: { id: string; len: number } | undefined
  for (const m of model.modules) {
    for (const p of m.paths) {
      if ((p === '' && !file.includes('/')) || (p !== '' && file.startsWith(p))) {
        if (!best || p.length > best.len) best = { id: m.id, len: p.length }
      }
    }
  }
  return best?.id
}

export function isAllowed(model: ArchitectureModel, from: string, to: string): boolean | null {
  const list = model.allowed[from]
  if (!list) return null
  return list.includes('*') || list.includes(to)
}
