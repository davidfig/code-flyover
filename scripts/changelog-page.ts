// Writes site/changelog.html from CHANGELOG.md, the same file the app shows under What's New. It borrows the landing
// page's <style> block (site/index.html), so the two pages keep the same colours and type.
//
// Run with `npm run changelog:site`; `npm run deploy:site` runs it first.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogHtml } from '../shared/changelog.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const md = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const index = readFileSync(path.join(root, 'site/index.html'), 'utf8')
const style = /<style>([\s\S]*?)<\/style>/.exec(index)?.[1]
if (!style) throw new Error('site/index.html has no <style> block to borrow')

const own = `
.log{max-width:760px;padding:40px 0 72px}
.log h1{font-size:clamp(30px,5vw,44px);margin:0 0 10px;max-width:none;text-align:left}
.log .lead{margin:0 0 24px;text-align:left}
.release{padding:28px 0;border-top:1px solid var(--line)}
.release h3{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin:0 0 8px;font-size:24px;letter-spacing:-.01em}
.release time{font-size:15px;font-weight:400;color:var(--muted)}
.release h4{margin:20px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.release p{margin:8px 0}
.release ul{margin:6px 0;padding-left:22px}
.release li{margin:6px 0}
.release code,.log .lead code{font:.88em var(--mono);padding:1px 5px;border-radius:5px;background:var(--panel);border:1px solid var(--line)}
`

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changelog — Code Flyover</title>
<meta name="description" content="What changed in each release of Code Flyover.">
<meta property="og:title" content="Code Flyover changelog">
<meta property="og:url" content="https://codeflyover.app/changelog">
<link rel="icon" href="icon.png">
<!-- Made by scripts/changelog-page.ts from CHANGELOG.md. Edit that file, not this one. -->
<style>${style}${own}</style>
</head>
<body>
<div class="wrap">
  <nav>
    <a class="brand" href="/"><img src="icon.png" alt="">Code Flyover</a>
    <a class="l" href="/#download">Download</a>
    <a class="l" href="https://github.com/davidfig/code-flyover">GitHub</a>
  </nav>
  <main class="log">
    <h1>Changelog</h1>
    <p class="lead">What changed in each release. The app shows the same list under <strong>What’s New</strong>, and updates itself when a new release is out.</p>
${changelogHtml(md)}
  </main>
  <footer>
    <span>© 2026 David Figatner · MIT licensed</span>
    <a href="https://github.com/davidfig/code-flyover">GitHub</a>
    <a href="/changelog">Changelog</a>
    <span class="r">codeflyover.app</span>
  </footer>
</div>
</body>
</html>
`

const out = path.join(root, 'site/changelog.html')
writeFileSync(out, page)
console.log(`Wrote ${path.relative(root, out)}`)
