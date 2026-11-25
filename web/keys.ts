// Keyboard shortcuts as the settings hold them: "J", "Shift+ArrowRight", "Alt+PageDown", or "" for none. Shift and
// Alt (Option) are the only modifiers: ⌘ and Ctrl shortcuts belong to the menus, the browser and the system.

/** What a key press reads from a keyboard event. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>

/** Keys that keep their own job: pressing a button, moving the focus, closing things, clearing a shortcut. */
const RESERVED = ['Escape', 'Tab', 'Enter', ' ', 'Space', 'Backspace', 'Delete', 'Dead', 'Process', 'Unidentified']
const MODIFIERS = ['Shift', 'Alt', 'AltGraph', 'Control', 'Meta', 'CapsLock', 'Fn', 'NumLock']

export const isModifier = (key: string) => MODIFIERS.includes(key)

/** The shortcut a key press is, or null if it can't be one. */
export function shortcutOf(e: KeyPress): string | null {
  if (e.ctrlKey || e.metaKey) return null
  let key = e.key
  // Option types another character on a Mac (⌥J is ∆): go by the key itself.
  if (e.altKey) key = /^(?:Key|Digit)(.)$/.exec(e.code)?.[1] ?? key
  // A shifted symbol ("?") says so already; only letters and named keys keep Shift.
  const shift = e.shiftKey && (key.length > 1 || key.toLowerCase() !== key.toUpperCase() || (e.altKey && /^\d$/.test(key)))
  return cleanShortcut((e.altKey ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key) ?? null
}

/** A shortcut from a settings file, in its one spelling; undefined if it isn't one. */
export function cleanShortcut(s: string): string | undefined {
  if (s === '') return ''
  const m = /^((?:(?:Alt|Shift)\+)*)(.|[A-Z][A-Za-z0-9]+)$/u.exec(s)
  if (!m || RESERVED.includes(m[2]) || isModifier(m[2])) return undefined
  const key = [...m[2]].length === 1 ? m[2].toUpperCase() : m[2]
  return (m[1].includes('Alt+') ? 'Alt+' : '') + (m[1].includes('Shift+') ? 'Shift+' : '') + key
}

/** Whether it's a key like an arrow, which lists and scrolling panes also use, rather than one that types a character. */
export const isNamedKey = (shortcut: string) => /[A-Z][A-Za-z0-9]+$/.test(shortcut.slice(shortcut.lastIndexOf('+', shortcut.length - 2) + 1))

const NAMES: Record<string, string> = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', PageUp: 'Page Up', PageDown: 'Page Down' }

/** A shortcut as people read it: "⇧→" on a Mac, "Shift+→" elsewhere. */
export function shortcutLabel(s: string): string {
  if (!s) return ''
  const mac = /Mac/.test(navigator.platform)
  const key = s.replace(/^(?:Alt\+)?(?:Shift\+)?/, '')
  return (s.startsWith('Alt+') ? (mac ? '⌥' : 'Alt+') : '') + (/^(?:Alt\+)?Shift\+/.test(s) ? (mac ? '⇧' : 'Shift+') : '') + (NAMES[key] ?? key)
}
