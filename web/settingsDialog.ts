// The Settings dialog: every setting in settings.ts, in its groups, each with its help and a way back to its default.
// Changes apply as they're made and are saved by settingsStore.ts; there's no OK or Cancel. A filter box finds a
// setting by name or help; Import and Export read and write the same JSON the settings are stored as.

import { DEFS, GROUPS, KEYS, onSettingsChange, settings, update, type NumberDef, type SettingKey } from './settings.ts'
import { openWhatsNew } from './whatsNew.ts'
import { exportSettings, importText, onSaveError, resetAll, storageName } from './settingsStore.ts'

let dialog: HTMLDialogElement | null = null

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** A number as a setting shows it: no trailing zeros, at most its step's decimals. */
function fmt(d: NumberDef, v: number): string {
  const decimals = (String(d.step).split('.')[1] ?? '').length
  return String(Number(v.toFixed(decimals)))
}

export function openSettings(focusKey?: SettingKey) {
  if (dialog) {
    dialog.showModal()
    return
  }
  const d = el('dialog', 'settings')
  d.setAttribute('aria-labelledby', 'settings-title')
  dialog = d

  // ---- title bar: name, filter, close ----
  const title = el('h2', undefined, 'Settings')
  title.id = 'settings-title'
  const filter = el('input', 'settings-filter')
  filter.type = 'search'
  filter.placeholder = 'Find a setting'
  filter.setAttribute('aria-label', 'Find a setting')
  filter.spellcheck = false
  const close = el('button', 'settings-close', '✕')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => d.close()
  const top = el('div', 'settings-top')
  top.append(title, filter, close)

  // ---- groups down the left, settings on the right ----
  const nav = el('nav', 'settings-nav')
  const body = el('div', 'settings-body')
  const sections = new Map<string, HTMLElement>()
  const navLinks = new Map<string, HTMLButtonElement>()
  /** Puts each control back in step with `settings` (after a reset, an import, or a change made outside the dialog). */
  const syncers = new Map<SettingKey, () => void>()

  for (const group of GROUPS) {
    const section = el('section', 'settings-group')
    section.dataset.group = group
    const h = el('h3', undefined, group)
    section.append(h)
    for (const key of KEYS.filter((k) => DEFS[k].group === group)) section.append(row(key))
    body.append(section)
    sections.set(group, section)
    const link = el('button', 'settings-nav-item', group)
    link.type = 'button'
    link.onclick = () => {
      filter.value = ''
      applyFilter()
      body.scrollTo({ top: section.offsetTop - body.offsetTop, behavior: 'smooth' })
    }
    nav.append(link)
    navLinks.set(group, link)
  }
  const none = el('p', 'settings-none', 'No setting matches.')
  none.hidden = true
  body.append(none)

  function row(key: SettingKey): HTMLElement {
    const def = DEFS[key]
    const r = el('div', `settings-row ${def.type}`)
    r.dataset.key = key
    r.dataset.search = `${def.label} ${def.help} ${def.group} ${key}`.toLowerCase()
    const id = `setting-${key}`
    const label = el('label', 'settings-label', def.label)
    label.htmlFor = id
    const reset = el('button', 'settings-reset', '↺')
    reset.type = 'button'
    reset.title = 'Back to the default'
    reset.onclick = () => update({ [key]: def.default })
    const help = el('div', 'settings-help', def.help)
    help.id = `${id}-help`
    const text = el('div', 'settings-text')
    text.append(label, help)
    const control = el('div', 'settings-control')
    let sync: () => void

    if (def.type === 'boolean') {
      const box = el('input', 'settings-switch')
      box.type = 'checkbox'
      box.id = id
      box.setAttribute('role', 'switch')
      box.setAttribute('aria-describedby', help.id)
      box.onchange = () => update({ [key]: box.checked })
      control.append(box)
      sync = () => (box.checked = settings[key] as boolean)
    } else {
      // A box for the number: type any value from the minimum up; the arrow keys and the stepper move it by its step.
      // Set on Enter, on leaving the box, or on a step.
      const box = el('input', 'settings-number')
      box.type = 'number'
      box.id = id
      box.min = String(def.min)
      box.step = String(def.step)
      box.setAttribute('aria-describedby', help.id)
      box.onchange = () => {
        update({ [key]: box.value })
        sync()
      }
      control.append(box)
      if (def.unit) control.append(el('span', 'settings-unit', def.unit))
      sync = () => (box.value = fmt(def, settings[key] as number))
    }
    const fullSync = () => {
      sync()
      const changed = settings[key] !== def.default
      r.classList.toggle('changed', changed)
      reset.hidden = !changed
      const dflt = def.type === 'number' ? `${fmt(def, def.default)}${def.unit ? ` ${def.unit}` : ''}` : def.default ? 'on' : 'off'
      reset.setAttribute('aria-label', `Put ${def.label} back to ${dflt}`)
      reset.title = `Back to the default (${dflt})`
    }
    syncers.set(key, fullSync)
    fullSync()
    const head = el('div', 'settings-head')
    head.append(text, reset)
    r.append(head, control)
    return r
  }

  function applyFilter() {
    const q = filter.value.trim().toLowerCase()
    let any = false
    for (const [group, section] of sections) {
      let shown = 0
      for (const r of section.querySelectorAll<HTMLElement>('.settings-row')) {
        r.hidden = !!q && !r.dataset.search!.includes(q)
        if (!r.hidden) shown++
      }
      section.hidden = shown === 0
      navLinks.get(group)!.disabled = shown === 0
      any ||= shown > 0
    }
    none.hidden = any
  }
  filter.oninput = applyFilter
  filter.onkeydown = (e) => {
    // Escape clears the filter first, then closes.
    if (e.key === 'Escape' && filter.value) {
      e.preventDefault()
      filter.value = ''
      applyFilter()
    }
  }

  // The group in view is the one lit in the list on the left.
  body.addEventListener('scroll', () => {
    const y = body.scrollTop + 24
    let current = GROUPS[0] as string
    for (const [group, section] of sections) if (!section.hidden && section.offsetTop - body.offsetTop <= y) current = group
    for (const [group, link] of navLinks) link.classList.toggle('current', group === current)
  })
  navLinks.get(GROUPS[0])!.classList.add('current')

  // ---- footer: where they're kept, What's New (the browser has no menu for it), import, export, reset ----
  const status = el('div', 'settings-status')
  const where = () => {
    status.className = 'settings-status'
    status.textContent = `Saved as you go, in ${storageName()}.`
  }
  where()
  const say = (msg: string, error = false) => {
    status.textContent = msg
    status.className = error ? 'settings-status error' : 'settings-status note'
  }
  onSaveError((e) => say(`Couldn’t save: ${e instanceof Error ? e.message : e}`, true))

  const button = (text: string, onclick: () => void, cls = '') => {
    const b = el('button', `settings-button ${cls}`.trim(), text)
    b.type = 'button'
    b.onclick = onclick
    return b
  }
  const fileInput = el('input')
  fileInput.type = 'file'
  fileInput.accept = '.json,application/json'
  fileInput.hidden = true
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    try {
      const { changed, rejected } = importText(await file.text())
      const parts = [changed.length ? `Imported ${file.name}: ${changed.length} setting${changed.length === 1 ? '' : 's'} changed.` : `Imported ${file.name}: nothing different from what’s set.`]
      if (rejected.length) parts.push(`Skipped ${rejected.join(', ')}.`)
      say(parts.join(' '), rejected.length > 0)
    } catch (e) {
      say(`Couldn’t import ${file.name}: ${e instanceof Error ? e.message : e}`, true)
    }
  }
  const importBtn = button('Import…', () => fileInput.click())
  const exportBtn = button('Export…', async () => {
    try {
      const to = await exportSettings()
      if (to) say(`Exported to ${to}.`)
    } catch (e) {
      say(`Couldn’t export: ${e instanceof Error ? e.message : e}`, true)
    }
  })
  const resetBtn = button('Reset All', () => {
    if (!confirm('Put every setting back to its default?')) return
    const changed = resetAll()
    say(changed.length ? `${changed.length} setting${changed.length === 1 ? '' : 's'} put back to the default.` : 'Everything was already at its default.')
  })
  const whatsNew = button('What’s New', () => {
    d.close()
    openWhatsNew()
  })
  const done = button('Done', () => d.close(), 'primary')
  const left = el('div', 'settings-buttons')
  left.append(importBtn, exportBtn, resetBtn)
  const foot = el('div', 'settings-foot')
  foot.append(status, whatsNew, left, done, fileInput)

  const main = el('div', 'settings-main')
  main.append(nav, body)
  d.append(top, main, foot)

  const stop = onSettingsChange((changed) => {
    for (const k of changed) syncers.get(k)?.()
  })
  // Keys stay in the dialog: the map's (j, k, Escape) listen on the window.
  d.addEventListener('keydown', (e) => e.stopPropagation())
  // A click on the backdrop closes it.
  d.addEventListener('mousedown', (e) => {
    if (e.target === d) d.close()
  })
  d.addEventListener('close', () => {
    stop()
    d.remove()
    dialog = null
  })
  document.body.append(d)
  d.showModal()
  if (focusKey) {
    const r = body.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)
    r?.scrollIntoView({ block: 'center' })
    r?.querySelector<HTMLElement>('input')?.focus()
  } else filter.focus()
}
