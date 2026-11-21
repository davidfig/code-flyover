// The intended architecture: loaded from models/<repo>.json when present,
// otherwise inferred from the repo's layout (workspace folders and top-level folders).

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

export function loadModel(modelsDir: string, repoName: string, files: string[]): LoadedModel {
  const file = path.join(modelsDir, `${repoName}.json`)
  const modules: ModuleDef[] = []
  let model: ArchitectureModel
  let noThirdParty = new Set<string>()
  if (fs.existsSync(file)) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as ModelFile
    for (const mod of m.modules) {
      modules.push({ id: mod.id, label: mod.label ?? mod.id, paths: mod.paths, description: mod.description, modeled: true })
    }
    model = { name: m.name, source: m.source, kind: 'intended', modules, allowed: m.allowed ?? {}, rules: m.rules ?? [] }
    noThirdParty = new Set(m.noThirdParty ?? [])
  } else {
    model = {
      name: 'Inferred from folders',
      source: 'inferred: no models/' + repoName + '.json, so the base branch’s dependencies count as the intended ones',
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
