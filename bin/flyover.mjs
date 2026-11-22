#!/usr/bin/env node
// semantic-zoom [folder]: opens the app on a repo's branches.
// semantic-zoom --serve:   only starts the server (the desktop app runs this, src-tauri/src/lib.rs).
// semantic-zoom export …:  what an outside AI needs to describe and review a branch (server/review-cli.ts)
// semantic-zoom import …:  saves what it wrote, for the app to show
//
// Adds the git repo at [folder] (default: the current folder) to the app's list and opens it in the browser. Starts
// the app's server on http://localhost:5197 first if it isn't running yet, and keeps it running (Ctrl-C stops it);
// if it is already running, just opens the page.
//
// The server is Vite with the app's API (vite.config.ts, server/api.ts), so there's no build step: what's in this
// checkout is what runs.

import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv[2] === 'export' || process.argv[2] === 'import') {
  // Run from the caller's folder, so relative paths and the checked-out branch are theirs. No server needed.
  const tsx = path.join(appDir, 'node_modules', '.bin', 'tsx')
  const r = spawnSync(tsx, [path.join(appDir, 'server', 'review-cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

const PORT = Number(process.env.SEMANTIC_ZOOM_PORT ?? 5197)
const origin = `http://localhost:${PORT}`
const serveOnly = process.argv[2] === '--serve'
const folder = path.resolve((!serveOnly && process.argv[2]) || process.cwd())

const running = async () => {
  try {
    return (await fetch(`${origin}/api/repos`)).ok
  } catch {
    return false
  }
}

const openBrowser = (url) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
}

const alreadyRunning = await running()
if (!alreadyRunning) {
  const { createServer } = await import('vite')
  const server = await createServer({ root: appDir, configFile: path.join(appDir, 'vite.config.ts'), server: { port: PORT, strictPort: true, open: false }, logLevel: 'warn' })
  await server.listen()
  console.log(`Semantic Zoom is running at ${origin}/ (Ctrl-C to stop)`)
}

if (serveOnly) {
  if (alreadyRunning) {
    console.log(`Already running at ${origin}/`)
    process.exit(0)
  }
  await new Promise(() => {}) // keep serving until stopped
}

// Add the repo, if the folder is in one; otherwise just open the app.
let hash = ''
const res = await fetch(`${origin}/api/repos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }) })
if (res.ok) hash = '#' + new URLSearchParams({ repo: (await res.json()).id })
else if (process.argv[2] && !serveOnly) console.warn((await res.json().catch(() => ({}))).error ?? `Couldn't add ${folder}`)
openBrowser(`${origin}/${hash}`)
if (alreadyRunning) console.log(`Opened ${origin}/${hash}`)
