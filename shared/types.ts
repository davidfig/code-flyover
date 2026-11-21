// The analysis file the analyzer writes and the viewer reads.

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged'

export interface DiffLine {
  /** '+' added, '-' removed, ' ' context */
  t: '+' | '-' | ' '
  s: string
}

export interface Hunk {
  header: string
  lines: DiffLine[]
}

export interface FileInfo {
  path: string
  /** path at base, when renamed */
  oldPath?: string
  module: string
  /** lines at head (or at base, for deleted files) */
  lines: number
  status: FileStatus
  add: number
  del: number
  hunks?: Hunk[]
  /** true when this file is a test */
  test: boolean
}

export type EdgeState = 'both' | 'added' | 'removed'

/** File-level import edge, by index into `files`. */
export interface FileEdge {
  from: number
  to: number
  state: EdgeState
  /** the import line, for added and removed edges */
  line?: string
  /** every import between the two files is type-only (erased at compile time) */
  typeOnly?: boolean
}

export interface ModuleDef {
  id: string
  label: string
  /** path prefixes that belong to this module */
  paths: string[]
  description?: string
  /** true when the module came from the intended-architecture file */
  modeled: boolean
}

export interface ArchitectureModel {
  name: string
  /** where the intended model came from (a doc in the repo, or "inferred") */
  source: string
  kind: 'intended' | 'inferred'
  modules: ModuleDef[]
  /** module id → module ids it may depend on ("*" for any). Missing key: anything allowed. */
  allowed: Record<string, string[]>
  /** plain-language rules shown to the reviewer */
  rules: string[]
}

export type Severity = 'violation' | 'warning' | 'info'

export interface FindingTarget {
  /** emphasize arrows that start and end inside these paths */
  focus?: boolean
  /** file or directory paths to zoom to */
  paths?: string[]
  /** module-level edge */
  edge?: { from: string; to: string }
}

export interface Finding {
  severity: Severity
  kind: string
  title: string
  detail?: string
  /** supporting evidence: import lines, file paths */
  evidence?: string[]
  target?: FindingTarget
}

export interface Analysis {
  id: string
  repo: string
  head: string
  base: string
  headSha: string
  baseSha: string
  title: string
  commits: { sha: string; subject: string }[]
  generatedAt: string
  model: ArchitectureModel
  files: FileInfo[]
  edges: FileEdge[]
  /** files that transitively import a changed file (indexes into files) */
  impacted: number[]
  findings: Finding[]
  /** changed files the map leaves out (docs, assets, locales), by kind */
  otherChanges: { path: string; status: FileStatus; add: number; del: number }[]
}

export interface AnalysisIndexEntry {
  id: string
  repo: string
  head: string
  title: string
  files: number
  add: number
  del: number
  findings: Record<Severity, number>
}
