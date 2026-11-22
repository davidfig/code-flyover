// What's New: CHANGELOG.md in a dialog. The file is bundled into the page (Vite's ?raw), so it shows offline and loads
// nothing from outside. Opened from the menu (What's New…) and from Settings.

import changelog from '../CHANGELOG.md?raw'
import { changelogHtml } from '../shared/changelog.ts'

let dialog: HTMLDialogElement | null = null

export function openWhatsNew() {
  if (dialog) {
    dialog.showModal()
    return
  }
  const d = document.createElement('dialog')
  d.className = 'settings whats-new'
  d.setAttribute('aria-labelledby', 'whats-new-title')
  dialog = d

  const top = document.createElement('div')
  top.className = 'settings-top'
  const title = document.createElement('h2')
  title.id = 'whats-new-title'
  title.textContent = 'What’s New'
  const close = document.createElement('button')
  close.className = 'settings-close'
  close.type = 'button'
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Close')
  close.onclick = () => d.close()
  top.append(title, close)

  const body = document.createElement('div')
  body.className = 'whats-new-body'
  // Our own file, escaped by changelogHtml; links open in the browser.
  body.innerHTML = changelogHtml(changelog)

  d.append(top, body)
  // Keys stay in the dialog: the map's (j, k, Escape) listen on the window.
  d.addEventListener('keydown', (e) => e.stopPropagation())
  d.addEventListener('mousedown', (e) => {
    if (e.target === d) d.close()
  })
  d.addEventListener('close', () => {
    d.remove()
    dialog = null
  })
  document.body.append(d)
  d.showModal()
  body.focus()
}
