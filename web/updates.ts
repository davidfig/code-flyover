// Updates in the desktop app (src-tauri/src/update.rs), as in satchel.email. The app checks for a new release by
// itself, downloads it in the background, then says so here with a toast that stays until you dismiss it:
// "Code Flyover X is ready to install — Restart to update". Nothing installs until you click it. Check for Updates…
// in the menu runs the same check now and says what it found.

/** The part of Tauri's global API this needs. */
export interface TauriUpdates {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
  event: { listen<T>(name: string, handler: (e: { payload: T }) => void): Promise<() => void> }
}

interface Toast {
  setMessage(text: string): void
  dismiss(): void
}

/** A toast in the bottom right corner. `sticky` ones stay until dismissed (with a ×); the rest go after `ms`. */
function toast(text: string, opts: { sticky?: boolean; ms?: number; kind?: 'error'; action?: { label: string; run: () => void } } = {}): Toast {
  let stack = document.getElementById('toasts')
  if (!stack) {
    stack = document.createElement('div')
    stack.id = 'toasts'
    document.body.append(stack)
  }
  const el = document.createElement('div')
  el.className = 'toast' + (opts.kind === 'error' ? ' error' : '')
  el.setAttribute('role', 'status')
  const message = document.createElement('span')
  message.textContent = text
  el.append(message)
  const dismiss = () => el.remove()
  if (opts.action) {
    const button = document.createElement('button')
    button.className = 'toast-action'
    button.textContent = opts.action.label
    const run = opts.action.run
    button.onclick = () => {
      dismiss()
      run()
    }
    el.append(button)
  }
  if (opts.sticky) {
    const close = document.createElement('button')
    close.className = 'toast-close'
    close.textContent = '×'
    close.title = 'Dismiss'
    close.onclick = dismiss
    el.append(close)
  } else {
    setTimeout(dismiss, opts.ms ?? 4000)
  }
  stack.append(el)
  return { setMessage: (t) => (message.textContent = t), dismiss }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let tauri: TauriUpdates | null = null
/** The toast of a check you asked for, while it runs. */
let checking: Toast | null = null
/** The version last offered, so the timer's checks don't offer it again after you dismissed it. */
let offered = ''

function offer(version: string) {
  offered = version
  toast(`Code Flyover ${version} is ready to install`, {
    sticky: true,
    action: {
      label: 'Restart to update',
      run: () => void tauri?.core.invoke('install_update').catch((e) => toast(`Couldn’t install the update: ${message(e)}`, { kind: 'error', ms: 7000 })),
    },
  })
}

/** Listens for downloaded updates and offers them. Call once, in the desktop app. */
export function installUpdates(api: TauriUpdates) {
  tauri = api
  // Only a check you're waiting on shows the download; the timer's stays quiet.
  void api.event.listen<{ version: string; percent: number | null }>('update-progress', ({ payload: { version, percent } }) => {
    checking?.setMessage(`Downloading Code Flyover ${version}…${percent === null ? '' : ` ${percent}%`}`)
  })
  void api.event.listen<string>('update-ready', ({ payload }) => {
    if (payload !== offered) offer(payload)
  })
  // One downloaded before this page loaded (the window shows a loading page first, and you can reload).
  void api.core.invoke<string | null>('update_ready').then((v) => {
    if (v && v !== offered) offer(v)
  }, () => {})
}

/** Check for Updates…: looks now, and says what it's doing and what it found. A newer version downloads first, so
 *  the toast stays up with its progress until then. A version already offered and dismissed is offered again, since
 *  you asked. */
export async function checkForUpdates() {
  if (!tauri || checking) return
  const shown = toast('Checking for updates…', { sticky: true })
  checking = shown
  try {
    const { current, ready } = await tauri.core.invoke<{ current: string; ready: string | null }>('check_for_updates')
    shown.dismiss()
    if (ready) offer(ready)
    else toast(`You’re on the latest version (${current}).`)
  } catch (e) {
    shown.dismiss()
    toast(`Couldn’t check for updates: ${message(e)}`, { kind: 'error', ms: 7000 })
  } finally {
    checking = null
  }
}
