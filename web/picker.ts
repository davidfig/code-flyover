// The drop-down list every choice in the app uses (repo, branch, what the branch is compared with), never a native
// <select>: a button showing the current choice, and a list under it. Borrowed from golemdocs' choiceButton and popup,
// with what a long list of branches needs on top: each row has a muted detail on the right (how far ahead, how old),
// a filter box when the list is long, and commands (Add a repo…) in their own group under a divider.
//
// Keys: on the button, ↓ ↑ Enter or Space open it. In the list, ↓ ↑ Home End move, Enter picks, Escape or Tab closes;
// typing filters (or, in a short list, jumps to the row starting with that letter).

export interface PickerItem {
  value: string
  label: string
  /** Muted text right after the label, on the row and on the button. */
  badge?: string
  /** Muted text on the right of the row (not on the button). */
  detail?: string
  /** A tooltip for the row. */
  title?: string
}

export interface PickerGroup {
  heading?: string
  items: PickerItem[]
}

export interface PickerCommand {
  label: string
  run(): void
}

export interface PickerSpec {
  /** What the control is called: its tooltip and accessible name. */
  label: string
  /** The choices, asked for each time the list opens. */
  groups(): PickerGroup[]
  /** Commands under the choices, after a divider. */
  commands?(): PickerCommand[]
  /** Called with the value picked (only when it differs from the current one). */
  onPick(value: string): void
  /** Show a filter box from this many choices up (default 8). */
  filterFrom?: number
}

export interface Picker {
  readonly el: HTMLButtonElement
  value: string
  /** Shows `value` on the button; `label` when it isn't among the choices. */
  set(value: string, label?: string): void
  disabled: boolean
}

let open: { owner: HTMLButtonElement; panel: HTMLElement; close(refocus: boolean): void } | null = null

/** Closes the open picker, if any. */
export function closePicker(refocus = false) {
  open?.close(refocus)
}

let listening = false
function listen() {
  if (listening) return
  listening = true
  window.addEventListener('pointerdown', (e) => {
    if (!open) return
    const t = e.target as Node
    if (!open.panel.contains(t) && !open.owner.contains(t)) closePicker()
  }, true)
  window.addEventListener('blur', () => closePicker())
  window.addEventListener('resize', () => closePicker())
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

let ids = 0

export function picker(spec: PickerSpec): Picker {
  const name = el('span', 'picker-name')
  const button = el('button', 'picker')
  button.type = 'button'
  button.title = spec.label
  button.setAttribute('aria-label', spec.label)
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  name.id = `picker-${++ids}`
  button.setAttribute('aria-describedby', name.id)
  button.append(name, el('span', 'picker-caret'))

  let current = ''
  const control: Picker = {
    el: button,
    get value() { return current },
    set value(v) { control.set(v) },
    set(value, label) {
      current = value
      const item = spec.groups().flatMap((g) => g.items).find((i) => i.value === value)
      name.textContent = item?.label ?? label ?? value
      if (item?.badge) name.append(' ', el('span', 'picker-badge', item.badge))
    },
    get disabled() { return button.disabled },
    set disabled(d) { button.disabled = d },
  }

  button.addEventListener('keydown', (e) => {
    if (open?.owner === button) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      show()
    }
  })
  button.addEventListener('click', () => (open?.owner === button ? closePicker() : show()))

  function show() {
    closePicker()
    listen()
    const groups = spec.groups()
    const commands = spec.commands?.() ?? []
    const total = groups.reduce((n, g) => n + g.items.length, 0)
    const panel = el('div', 'picker-pop')
    const list = el('div', 'picker-list')
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', spec.label)
    list.tabIndex = -1
    const filter = total >= (spec.filterFrom ?? 8) ? el('input', 'picker-filter') : null

    // Every row the keys move through, choices then commands, as shown (filtered rows drop out).
    type Row = { el: HTMLElement; text: string; pick(): void; group?: HTMLElement }
    const rows: Row[] = []
    let active = -1
    const shown = () => rows.filter((r) => !r.el.hidden)
    const highlight = (row: Row | undefined) => {
      for (const r of rows) r.el.classList.toggle('active', r === row)
      active = row ? rows.indexOf(row) : -1
      if (row) {
        row.el.id ||= `picker-row-${++ids}`
        ;(filter ?? list).setAttribute('aria-activedescendant', row.el.id)
        row.el.scrollIntoView({ block: 'nearest' })
      } else (filter ?? list).removeAttribute('aria-activedescendant')
    }

    let chosen: Row | undefined
    for (const g of groups) {
      if (!g.items.length) continue
      let into: HTMLElement = list
      if (g.heading) {
        into = el('div', 'picker-group')
        into.setAttribute('role', 'group')
        into.setAttribute('aria-label', g.heading)
        into.append(el('div', 'picker-heading', g.heading))
        list.append(into)
      }
      for (const item of g.items) {
        const isChosen = item.value === current
        const r = el('div', isChosen ? 'picker-row chosen' : 'picker-row')
        r.setAttribute('role', 'option')
        r.setAttribute('aria-selected', String(isChosen))
        if (item.title) r.title = item.title
        r.append(el('span', 'picker-check', isChosen ? '✓' : ''), el('span', 'picker-label', item.label))
        if (item.badge) r.append(el('span', 'picker-badge', item.badge))
        if (item.detail) r.append(el('span', 'picker-detail', item.detail))
        const row: Row = {
          el: r,
          text: `${item.label} ${item.badge ?? ''} ${item.detail ?? ''}`.toLowerCase(),
          group: g.heading ? into : undefined,
          pick: () => {
            close(true)
            if (item.value !== current) spec.onPick(item.value)
          },
        }
        if (isChosen) chosen = row
        rows.push(row)
        into.append(r)
      }
    }
    const empty = el('div', 'picker-empty', 'No matches')
    empty.hidden = true
    list.append(empty)
    if (commands.length) {
      const cmds = el('div', 'picker-commands')
      for (const c of commands) {
        const r = el('div', 'picker-row picker-command')
        r.setAttribute('role', 'option')
        r.setAttribute('aria-selected', 'false')
        r.append(el('span', 'picker-check'), el('span', 'picker-label', c.label))
        rows.push({ el: r, text: '', pick: () => { close(true); c.run() } })
        cmds.append(r)
      }
      list.append(cmds)
    }

    for (const row of rows) {
      row.el.addEventListener('mousemove', () => active !== rows.indexOf(row) && highlight(row))
      row.el.addEventListener('click', () => row.pick())
    }
    // Clicks in the list don't take the focus from the filter box or the list.
    panel.addEventListener('mousedown', (e) => {
      if (e.target !== filter) e.preventDefault()
    })

    const applyFilter = () => {
      const q = filter!.value.trim().toLowerCase()
      for (const r of rows) if (r.text) r.el.hidden = !!q && !r.text.includes(q)
      for (const g of list.querySelectorAll<HTMLElement>('.picker-group')) g.hidden = ![...g.querySelectorAll<HTMLElement>('.picker-row')].some((r) => !r.hidden)
      empty.hidden = rows.some((r) => r.text && !r.el.hidden)
      const visible = shown()
      highlight(visible.find((r) => r === chosen) ?? visible[0])
    }

    let typed = ''
    let typedAt = 0
    panel.addEventListener('keydown', (e) => {
      const visible = shown()
      const at = visible.indexOf(rows[active])
      const move = (i: number) => highlight(visible[Math.max(0, Math.min(visible.length - 1, i))])
      let handled = true
      if (e.key === 'ArrowDown') move(at + 1)
      else if (e.key === 'ArrowUp') move(at - 1)
      else if (e.key === 'PageDown') move(at + 8)
      else if (e.key === 'PageUp') move(at - 8)
      else if (e.key === 'Home' && !filter) move(0)
      else if (e.key === 'End' && !filter) move(visible.length - 1)
      else if (e.key === 'Enter') rows[active]?.pick()
      else if (e.key === 'Escape') {
        if (filter?.value) {
          filter.value = ''
          applyFilter()
        } else close(true)
      } else if (e.key === 'Tab') close(false)
      else if (!filter && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        // A short list: typing jumps to the row that starts with what was typed.
        const now = Date.now()
        typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase()
        typedAt = now
        const hit = visible.find((r) => r.text.startsWith(typed))
        if (hit) highlight(hit)
      } else handled = false
      // The map's own keys (j, k, Escape) listen on the window: what the list used goes no further.
      e.stopPropagation()
      if (handled) e.preventDefault()
    })

    if (filter) {
      filter.type = 'text'
      filter.placeholder = `Filter ${total} ${spec.label.toLowerCase()}…`
      filter.setAttribute('aria-label', `Filter ${spec.label}`)
      filter.setAttribute('role', 'combobox')
      filter.setAttribute('aria-expanded', 'true')
      filter.spellcheck = false
      filter.autocomplete = 'off'
      filter.addEventListener('input', applyFilter)
      panel.append(filter)
    }
    panel.append(list)
    document.body.append(panel)

    // Under the button, at least as wide as it; above it if there's more room there; kept in the window.
    const a = button.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const below = vh - a.bottom - 12
    const above = a.top - 12
    const up = below < 240 && above > below
    panel.style.minWidth = `${a.width}px`
    panel.style.maxHeight = `${Math.min(480, up ? above : below)}px`
    panel.style.left = `${Math.max(4, Math.min(a.left, vw - panel.offsetWidth - 4))}px`
    if (up) panel.style.bottom = `${vh - a.top + 4}px`
    else panel.style.top = `${a.bottom + 4}px`

    function close(refocus: boolean) {
      if (open?.panel !== panel) return
      open = null
      panel.remove()
      button.classList.remove('open')
      button.setAttribute('aria-expanded', 'false')
      if (refocus) button.focus({ preventScroll: true })
    }
    open = { owner: button, panel, close }
    button.classList.add('open')
    button.setAttribute('aria-expanded', 'true')
    highlight(chosen ?? rows[0])
    if (chosen) chosen.el.scrollIntoView({ block: 'center' })
    ;(filter ?? list).focus({ preventScroll: true })
  }

  return control
}
