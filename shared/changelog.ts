// CHANGELOG.md as HTML, for What's New in the app (web/whatsNew.ts) and the changelog page on the site
// (scripts/changelog-page.ts). Reads only the Markdown the changelog uses: `## version - date` releases, `###` kinds of
// change, `- ` bullets (continued by indented lines), paragraphs, **bold**, `code` and [links](url). The title and the
// note on how to keep the file (everything before the first `##`) are left out.

export interface Release {
  /** "Unreleased" or a version, such as "0.1.1". */
  version: string
  /** yyyy-mm-dd, or '' when unreleased. */
  date: string
  /** The release's body as HTML. */
  html: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One line's inline Markdown: `code` first, so nothing inside it is read as bold or a link. */
function inline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return `<code>${esc(part.slice(1, -1))}</code>`
      return esc(part)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    })
    .join('')
}

/** The releases in the changelog, newest first, as the file lists them. Unreleased is left out when it has no entries. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = []
  let current: { version: string; date: string; lines: string[] } | null = null
  const finish = () => {
    if (!current) return
    const html = body(current.lines)
    if (html || current.version.toLowerCase() !== 'unreleased') releases.push({ version: current.version, date: current.date, html })
  }
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^## +\[?([^\]\s]+)\]?(?: *[-–—] *(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line)
    if (heading) {
      finish()
      current = { version: heading[1], date: heading[2] ?? '', lines: [] }
    } else if (current) current.lines.push(line)
  }
  finish()
  return releases
}

/** A release's lines as HTML: `###` headings, bullet lists and paragraphs. */
function body(lines: string[]): string {
  const out: string[] = []
  let list: string[] | null = null
  let para: string[] | null = null
  const flush = () => {
    if (para) out.push(`<p>${inline(para.join(' '))}</p>`)
    if (list) out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
    para = list = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const h = /^### +(.+)$/.exec(line)
    const bullet = /^[-*] +(.+)$/.exec(line)
    if (!line.trim()) {
      // A blank line ends a paragraph; a list carries on over one.
      if (para) flush()
    } else if (h) {
      flush()
      out.push(`<h4>${inline(h[1])}</h4>`)
    } else if (bullet) {
      if (para) flush()
      ;(list ??= []).push(bullet[1])
    } else if (list && /^\s/.test(line)) list[list.length - 1] += ' ' + line.trim()
    else {
      if (list) flush()
      ;(para ??= []).push(line.trim())
    }
  }
  flush()
  return out.join('\n')
}

/** "22 November 2026" from "2026-11-22". */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${d} ${months[m - 1]} ${y}`
}

/** The releases as HTML: a heading per release (its version and date), then its body. */
export function changelogHtml(md: string): string {
  return parseChangelog(md)
    .map((r) => {
      const name = r.version.toLowerCase() === 'unreleased' ? 'Coming next' : `Version ${esc(r.version)}`
      const date = r.date ? ` <time datetime="${esc(r.date)}">${formatDate(r.date)}</time>` : ''
      return `<section class="release" id="v${esc(r.version)}"><h3>${name}${date}</h3>\n${r.html}</section>`
    })
    .join('\n')
}
