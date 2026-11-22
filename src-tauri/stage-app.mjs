// Makes src-tauri/app/: a copy of what the server needs, so an installer carries it (tauri.bundle.conf.json lists it
// as a resource, and lib.rs runs the server from it). Without it the app runs from the checkout it was built in,
// which is right for a local build but not for an installer on someone else's machine.
//
// Run from anywhere: `node src-tauri/stage-app.mjs`. Needs npm and a network (installs Vite for this platform).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(here, 'app')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const entry of ['bin', 'server', 'analyzer', 'shared', 'web', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json']) {
  if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(out, entry), { recursive: true })
}

// Only Vite (and tsx, for `flyover export`/`import`) run in the app; install them at the versions package.json asks for.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const dependencies = {}
for (const name of ['vite', 'tsx']) dependencies[name] = pkg.devDependencies[name]
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'code-flyover-app', version: pkg.version, private: true, type: 'module', dependencies }, null, 2))
// --no-bin-links: no symlinks in the bundle (Tauri copies resources as plain files).
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' })
console.log(`Staged ${out}`)
