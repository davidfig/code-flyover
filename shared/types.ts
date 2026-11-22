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
  /**
   * The whole file, for changed files only: at head, or at base for a deleted file. The diff view uses it to
   * show the lines around a hunk and to highlight the file as one piece.
   */
  text?: string
  /** true when this file is a test */
  test: boolean
  /**
   * What the file is for. Only 'source' changes count toward the footprint;
   * tests, translations and generated files stay on the map but are muted.
   */
  role: FileRole
}

export type FileRole = 'source' | 'test' | 'locale' | 'generated'

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
  /** who wrote it, when an AI reviewer did (imported with `flyover import`); absent for the analyzer's own */
  by?: string
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
  /** what the branch does, in words, for the zoomed-out map (AI-written; absent if not generated) */
  changes?: ChangeSet
  /** the worktree whose uncommitted changes are included (the head is a snapshot of its files: analyzer/git.ts) */
  uncommitted?: string
  /** an outside AI's review of the branch (`flyover import`): its findings, kept apart from the analyzer's */
  review?: Review
}

/** An AI review written outside the app (say, in a Claude Code session) and imported with `flyover import`. */
export interface Review {
  by: string
  generatedAt: string
  /** the head commit it reviewed */
  headSha: string
  findings: Finding[]
  /** paths its findings named that aren't on the map (dropped from the findings' targets) */
  unknownPaths: string[]
  /** changed files, by path: what each is, and what this branch did to it (shown on hovering the file's label) */
  files?: Record<string, FileNote>
  /** folders that hold changed files, by path: what's kept in each, in a sentence (shown on hovering its name) */
  folders?: Record<string, string>
}

/** An AI's two lines about a changed file. */
export interface FileNote {
  /** what the file is, as it is now (the same on any branch) */
  about: string
  /** what this branch changed in it */
  change: string
}

/** A hunk's id: "<path>#<1-based hunk number>". */
export type HunkId = string

export interface Change {
  title: string
  summary: string
  hunks: HunkId[]
  /** the files those hunks are in */
  files: string[]
}


export interface ChangeSet {
  /** who wrote the descriptions: the model id */
  by: string
  generatedAt: string
  /** the head commit they describe (reused while it doesn't change) */
  headSha: string
  items: Change[]
  /** source hunks no description covers: the gaps a reviewer must read for themselves */
  undescribed: HunkId[]
  /** hunk ids the model cited that don't exist (dropped from the items) */
  invalid: HunkId[]
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
