// The app's settings: every choice the app makes that's a matter of taste rather than of what's right (how wide a code
// column is, when a folder opens, how far you can zoom, what the map shows). Each has a
// default, a range and a line of help, which the Settings dialog (settingsDialog.ts) is built from.
//
// No page code, so the text layout worker imports it too: the page posts it the values (text/worker.ts) and both read
// `settings` at the moment they need a value. Stored and imported/exported by settingsStore.ts, as JSON:
//   { "codeFlyoverSettings": 1, "settings": { "codeColumns": 100, … } }

export type SettingGroup = 'Code' | 'Map' | 'Zoom and mouse' | 'Window'
export const GROUPS: SettingGroup[] = ['Code', 'Map', 'Zoom and mouse', 'Window']

interface Base {
  group: SettingGroup
  label: string
  help: string
}
export interface NumberDef extends Base {
  type: 'number'
  default: number
  /** The smallest value that still works; there's no largest. */
  min: number
  /** How much the arrow keys move it; values are kept to its decimals. */
  step: number
  unit?: string
}
export interface BooleanDef extends Base {
  type: 'boolean'
  default: boolean
}
export type SettingDef = NumberDef | BooleanDef

const num = (group: SettingGroup, label: string, help: string, d: number, min: number, step: number, unit?: string): NumberDef => ({ type: 'number', group, label, help, default: d, min, step, unit })
const bool = (group: SettingGroup, label: string, help: string, d: boolean): BooleanDef => ({ type: 'boolean', group, label, help, default: d })

export const DEFS = {
  // Code
  codeColumns: num('Code', 'Code width', 'Characters on a line before it wraps. Sets how wide every file column on the map is.', 100, 20, 1, 'characters'),
  tabWidth: num('Code', 'Tab width', 'How many spaces a tab takes in the code.', 2, 1, 1, 'spaces'),
  expandLines: num('Code', 'Lines per “show more”', 'How many hidden lines one ↑ or ↓ button between two changes shows.', 20, 1, 1, 'lines'),
  tallestFileLines: num('Code', 'Tallest file box', 'How many lines of diff a file box grows to. A longer diff scrolls inside its box.', 107, 5, 1, 'lines'),

  // Map: what it shows
  showUnchanged: bool('Map', 'Unchanged files', 'Lay out the whole repo, not just the files the branch touches.', false),
  showTests: bool('Map', 'Tests', 'Unit and end-to-end tests on the map.', false),
  showLocales: bool('Map', 'Translations', 'Translation files on the map.', false),
  showImpacted: bool('Map', 'Importers of changed files', 'Show and shade the files that import a changed file.', true),
  dimUnchanged: bool('Map', 'Dim unchanged files', 'Fade the files the branch doesn’t touch.', false),
  showTiming: bool('Map', 'Frame timing', 'A readout of how long each frame takes to draw.', false),

  // Zoom and mouse
  openPx: num('Zoom and mouse', 'Folders open at', 'A module or folder shows what’s inside once it’s this wide on screen (its short side).', 170, 10, 10, 'px'),
  codeFadeFromPx: num('Zoom and mouse', 'Code appears at', 'Code this many pixels high starts to fade in, headings fade out, and clicks go to the code.', 3, 0.5, 0.5, 'px'),
  codeReadablePx: num('Zoom and mouse', 'Code is fully shown at', 'From this text size the code is drawn in full and the view counts as reading the diff.', 6.6, 1, 0.1, 'px'),
  maxZoomPercent: num('Zoom and mouse', 'Deepest zoom', 'How big code gets at the deepest zoom, against its normal 12 px.', 300, 100, 25, '%'),
  zoomSpeed: num('Zoom and mouse', 'Zoom speed', 'How fast a pinch or ⌘-scroll zooms.', 1, 0.1, 0.25, '×'),
  flyMs: num('Zoom and mouse', 'Fly time', 'How long the view takes to move to something you picked. 0 jumps straight there.', 650, 0, 50, 'ms'),
  doubleClickMs: num('Zoom and mouse', 'Double-click speed', 'The longest gap between two clicks that still counts as a double click.', 400, 50, 25, 'ms'),

  // Window
  panelWidth: num('Window', 'Side panel width', 'Dragging the divider sets this too; double-clicking it puts it back to the default.', 400, 260, 10, 'px'),
  panelTextPx: num('Window', 'Side panel text size', 'The size of the side panel’s body text. Headings, tags and code in it grow and shrink with it.', 13, 8, 1, 'px'),
  tipTextPx: num('Window', 'Hover card text size', 'The size of the text in the card that shows when you hover over a file or folder on the map.', 12, 8, 1, 'px'),
  liveCheckSeconds: num('Window', 'Check for new commits every', 'How often the open branch is checked for new commits and newly saved reviews while the window is in front.', 4, 1, 1, 's'),
} satisfies Record<string, SettingDef>

export type SettingKey = keyof typeof DEFS
export type Settings = { -readonly [K in SettingKey]: (typeof DEFS)[K]['default'] }

export const KEYS = Object.keys(DEFS) as SettingKey[]

export function defaults(): Settings {
  return Object.fromEntries(KEYS.map((k) => [k, DEFS[k].default])) as Settings
}

/** The values in use now. Change them with `update`, never directly. */
export const settings: Settings = defaults()

/**
 * A value made safe: a number kept to its step's decimals and at least its minimum; undefined when it can't be used
 * (wrong type).
 */
export function clean(key: SettingKey, v: unknown): Settings[SettingKey] | undefined {
  const d: SettingDef = DEFS[key]
  if (d.type === 'boolean') return typeof v === 'boolean' ? v : undefined
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  const decimals = (String(d.step).split('.')[1] ?? '').length
  return Math.max(d.min, Number(n.toFixed(decimals)))
}

type Listener = (changed: SettingKey[]) => void
const listeners = new Set<Listener>()
export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Sets some values (cleaned; unknown keys and unusable values are left out) and tells the listeners which changed.
 * Returns the keys it couldn't use.
 */
export function update(values: Record<string, unknown>, notify = true): { changed: SettingKey[]; rejected: string[] } {
  const changed: SettingKey[] = []
  const rejected: string[] = []
  for (const [k, v] of Object.entries(values)) {
    if (!(k in DEFS)) {
      rejected.push(k)
      continue
    }
    const key = k as SettingKey
    const c = clean(key, v)
    if (c === undefined) {
      rejected.push(k)
      continue
    }
    if (settings[key] !== c) {
      ;(settings as Record<SettingKey, unknown>)[key] = c
      changed.push(key)
    }
  }
  // Code that fades in has to be fully shown at a bigger size than where it starts.
  if (settings.codeReadablePx <= settings.codeFadeFromPx) {
    settings.codeReadablePx = Number((settings.codeFadeFromPx + 0.5).toFixed(4))
    if (!changed.includes('codeReadablePx')) changed.push('codeReadablePx')
  }
  if (notify && changed.length) for (const fn of listeners) fn(changed)
  return { changed, rejected }
}

// ---------- what the settings come to ----------

/** The code's text size, and the width of one character of it (Liberation Mono: 0.6 em). */
export const CODE_PX = 12
export const CHAR_PX = 7.2

/**
 * A file column's width in text px: the line-number gutter (11.5 characters), `codeColumns` characters of code, and the
 * right margin (8px), so lines up to that long don't wrap (text/layout.ts wraps the same way). 812 at 100 characters.
 */
export const colW = (): number => Math.ceil((11.5 + settings.codeColumns) * CHAR_PX + 8) + 1

/** A tab, as the code shows it. */
export const tabSpaces = (): string => ' '.repeat(settings.tabWidth)

/** The settings a file's text layout depends on: when one changes, every file is laid out again. */
export const LAYOUT_KEYS: SettingKey[] = ['codeColumns', 'tabWidth', 'expandLines', 'tallestFileLines']
