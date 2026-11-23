// Makes src-tauri/app/: a copy of what the server needs, so an installer carries it (tauri.bundle.conf.json lists it
// as a resource, and lib.rs runs the server from it). Without it the app runs from the checkout it was built in,
// which is right for a local build but not for an installer on someone else's machine.
//
// Run from anywhere: `node src-tauri/stage-app.mjs`. Needs npm and a network (installs Vite for this platform).
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(here, 'app')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
// CHANGELOG.md: bundled into the page for What's New (web/whatsNew.ts).
// skills/: the /flyover-review skill, which Install Claude Code Skill… (install.rs) copies into ~/.claude/skills.
for (const entry of ['bin', 'server', 'analyzer', 'shared', 'skills', 'web', 'public', 'index.html', 'CHANGELOG.md', 'vite.config.ts', 'tsconfig.json']) {
  if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(out, entry), { recursive: true })
}

// Only Vite (and tsx, for `flyover export`/`import`) run in the app; install them at the versions package.json asks for.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const dependencies = {}
for (const name of ['vite', 'tsx']) dependencies[name] = pkg.devDependencies[name]
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'code-flyover-app', version: pkg.version, private: true, type: 'module', dependencies }, null, 2))
// --no-bin-links: no symlinks in the bundle (Tauri copies resources as plain files).
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' })

// On a Mac with a Developer ID (APPLE_SIGNING_IDENTITY, set by the release workflow), sign the native binaries in the
// bundle: esbuild's executable and Rollup's .node library. Tauri signs the app around them but not files among its
// resources, and notarization rejects an app holding any unsigned Mach-O file.
const identity = process.env.APPLE_SIGNING_IDENTITY
if (process.platform === 'darwin' && identity) {
  const machO = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'])
  const isMachO = (file) => {
    const fd = openSync(file, 'r')
    const head = Buffer.alloc(4)
    const n = readSync(fd, head, 0, 4, 0)
    closeSync(fd)
    return n === 4 && machO.has(head.toString('hex'))
  }
  const signed = []
  for (const entry of readdirSync(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    if (!isMachO(file)) continue
    execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, file], { stdio: 'inherit' })
    signed.push(path.relative(out, file))
  }
  console.log(`Signed ${signed.length} native binaries:\n  ${signed.join('\n  ')}`)
}
console.log(`Staged ${out}`)
