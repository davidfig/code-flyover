// Syntax highlighting for diff lines: a small tokenizer, no library.
//
// A line becomes a list of tokens (keyword, string, comment, number, type, plain). State carries from line to
// line, so a block comment or a template string that spans lines stays coloured. It is deliberately simple; a
// better highlighter can replace `tokenizer()` without the renderer changing, since the renderer only sees tokens.

import { languageById, languageOf as languageDef, type Syntax } from '../shared/languages.ts'

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'type' | 'punct'

export interface Token {
  kind: TokenKind
  text: string
}

/** A language id from shared/languages.ts, Markdown, or plain text. */
export type Language = string

/**
 * Where a line ends up: inside a block comment, or inside a multi-line string with this closing quote. Markdown's:
 * inside a fenced code block (closed by this fence), or inside an HTML comment.
 */
export type LineState = { in: 'code' } | { in: 'comment' } | { in: 'string'; close: string } | { in: 'fence'; close: string } | { in: 'html' }

export interface Tokenizer {
  line(text: string, state: LineState): { tokens: Token[]; state: LineState }
}

export function languageOf(path: string): Language {
  if (/\.(md|mdx|markdown)$/i.test(path)) return 'markdown'
  return languageDef(path)?.id ?? 'plain'
}

/** Text in a language we don't know: strings and numbers, nothing else guessed. */
const PLAIN: Syntax = { keywords: '', quotes: '"' }

const cache = new Map<string, Tokenizer>()

export function tokenizer(lang: Language): Tokenizer {
  if (lang === 'markdown') return markdown
  let t = cache.get(lang)
  if (!t) cache.set(lang, (t = codeTokenizer(languageById(lang)?.syntax ?? PLAIN)))
  return t
}

function codeTokenizer(syntax: Syntax): Tokenizer {
  const keywords = new Set(syntax.keywords.split(' ').filter(Boolean))
  const { quotes, multiline = '', triple = false, line = [], block } = syntax
  return {
    line(text, state) {
      const tokens: Token[] = []
      const push = (kind: TokenKind, s: string) => {
        if (!s) return
        const last = tokens[tokens.length - 1]
        if (last && last.kind === kind) last.text += s
        else tokens.push({ kind, text: s })
      }
      let i = 0
      // Finish what the previous line left open.
      if (state.in === 'comment' && block) {
        const end = text.indexOf(block[1])
        if (end < 0) return { tokens: [{ kind: 'comment', text }], state }
        push('comment', text.slice(0, end + block[1].length))
        i = end + block[1].length
        state = { in: 'code' }
      } else if (state.in === 'string') {
        const end = closing(text, 0, state.close)
        if (end < 0) return { tokens: [{ kind: 'string', text }], state }
        push('string', text.slice(0, end))
        i = end
        state = { in: 'code' }
      }
      while (i < text.length) {
        const c = text[i]
        const rest = text.slice(i)
        const lc = line.find((m) => rest.startsWith(m))
        if (lc && commentStarts(lc, text, i)) {
          push('comment', rest)
          break
        }
        if (block && rest.startsWith(block[0])) {
          const end = text.indexOf(block[1], i + block[0].length)
          if (end < 0) {
            push('comment', rest)
            state = { in: 'comment' }
            break
          }
          push('comment', text.slice(i, end + block[1].length))
          i = end + block[1].length
          continue
        }
        if (quotes.includes(c)) {
          const q = triple && rest.startsWith(c + c + c) ? c + c + c : c
          const end = closing(text, i + q.length, q)
          if (end < 0) {
            push('string', rest)
            if (q.length === 3 || multiline.includes(c)) state = { in: 'string', close: q }
            break
          }
          push('string', text.slice(i, end))
          i = end
          continue
        }
        const num = /^(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)n?/i.exec(rest)
        if (num && !/[\w$]/.test(text[i - 1] ?? '')) {
          push('number', num[0])
          i += num[0].length
          continue
        }
        const word = /^[@!]?[A-Za-z_$][\w$]*\??/.exec(rest)
        if (word) {
          let w = word[0]
          if (!keywords.has(w)) {
            // `defined?` and `@interface` are keywords; `x?` and `@decorator` aren't.
            const bare = /^[A-Za-z_$][\w$]*/.exec(rest)
            if (bare && keywords.has(bare[0])) w = bare[0]
            else if (/^[@!]/.test(w)) w = w[0]
            else w = w.replace(/\?$/, '')
          }
          push(keywords.has(w) ? 'keyword' : /^[A-Z][a-z0-9]/.test(w) ? 'type' : /^[@!]$/.test(w) ? 'punct' : 'plain', w)
          i += w.length
          continue
        }
        push(/[{}()[\];,.<>=+\-*/%!&|^~?:@#]/.test(c) ? 'punct' : 'plain', c)
        i++
      }
      return { tokens, state }
    },
  }
}

/**
 * Whether a line-comment marker at `i` starts a comment: `#` only after a space or at the start (not `${#x}` or
 * `a#b`), `--` not as part of `---` or `i--`.
 */
function commentStarts(marker: string, text: string, i: number): boolean {
  const before = text[i - 1] ?? ' '
  if (marker === '#') return /[\s;(]/.test(before)
  if (marker === '--') return before !== '-' && !/[\w)\]]/.test(before)
  return true
}

/** Index just past the closing quote at or after `from`, skipping escaped ones; -1 if the line ends first. */
function closing(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text.startsWith(quote, i)) return i + quote.length
  }
  return -1
}

/**
 * Markdown, coloured by what each part is while staying one row per source line (the map shows diffs of it):
 * headings as keywords, code (spans and fenced blocks) as strings, link targets and HTML comments as comments,
 * link text and [[wikilinks]] as types, and the marks (list bullets, quotes, emphasis, table pipes, rules) as
 * punctuation.
 */
const markdown: Tokenizer = {
  line(text, state) {
    const tokens: Token[] = []
    const push = (kind: TokenKind, s: string) => {
      if (!s) return
      const last = tokens[tokens.length - 1]
      if (last && last.kind === kind) last.text += s
      else tokens.push({ kind, text: s })
    }
    if (state.in === 'fence') {
      const fence = /^\s*(`{3,}|~{3,})\s*$/.exec(text)
      if (fence && fence[1][0] === state.close[0] && fence[1].length >= state.close.length) return { tokens: [{ kind: 'comment', text }], state: { in: 'code' } }
      return { tokens: text ? [{ kind: 'string', text }] : [], state }
    }
    let i = 0
    if (state.in === 'html') {
      const end = text.indexOf('-->')
      if (end < 0) return { tokens: text ? [{ kind: 'comment', text }] : [], state }
      push('comment', text.slice(0, end + 3))
      i = end + 3
      state = { in: 'code' }
    }
    if (i === 0) {
      const open = /^\s*(`{3,}|~{3,})/.exec(text)
      if (open) return { tokens: [{ kind: 'comment', text }], state: { in: 'fence', close: open[1] } }
      if (/^\s{0,3}#{1,6}(\s|$)/.test(text)) return { tokens: [{ kind: 'keyword', text }], state }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(text)) return { tokens: [{ kind: 'punct', text }], state }
      // Leading marks: quotes, then a bullet or number, then a task box.
      const lead = /^(\s*(?:>\s?)*)(\s*(?:[-*+]|\d+[.)])\s+)?(\[[ xX]\]\s+)?/.exec(text)!
      if (lead[1].includes('>')) push('comment', lead[1])
      else push('plain', lead[1])
      push('punct', (lead[2] ?? '') + (lead[3] ?? ''))
      i = lead[0].length
    }
    while (i < text.length) {
      const rest = text.slice(i)
      let m: RegExpExecArray | null
      if (rest.startsWith('<!--')) {
        const end = text.indexOf('-->', i + 4)
        if (end < 0) {
          push('comment', rest)
          state = { in: 'html' }
          break
        }
        push('comment', text.slice(i, end + 3))
        i = end + 3
      } else if ((m = /^(`+)[^`]*?\1/.exec(rest))) {
        push('string', m[0])
        i += m[0].length
      } else if ((m = /^!?\[\[[^\]]*\]\]/.exec(rest))) {
        push('type', m[0])
        i += m[0].length
      } else if ((m = /^(!?\[)([^\]]*)(\])(\([^)]*\)|\[[^\]]*\])?/.exec(rest)) && (m[4] || /^\[[^\]]+\]:/.test(rest))) {
        push('punct', m[1])
        push('type', m[2])
        push('punct', m[3])
        if (m[4]) push('comment', m[4])
        i += m[0].length
      } else if ((m = /^<https?:\/\/[^>\s]+>|^https?:\/\/[^\s)>\]]+/.exec(rest))) {
        push('comment', m[0])
        i += m[0].length
      } else if ((m = /^(\*\*|__|\*|_|~~)/.exec(rest)) && emphasis(text, i, m[1].length)) {
        push('punct', m[1])
        i += m[1].length
      } else {
        push(text[i] === '|' ? 'punct' : 'plain', text[i])
        i++
      }
    }
    return { tokens, state }
  },
}

/**
 * Whether the mark at `i` (`**`, `_`, `~~`…) opens or closes emphasis: it touches a word on one side and space on
 * the other. Underscores inside a word (snake_case) don't count.
 */
function emphasis(text: string, i: number, len: number): boolean {
  const before = text[i - 1] ?? ' '
  const after = text[i + len] ?? ' '
  if (text[i] === '_' && /\w/.test(before) && /\w/.test(after)) return false
  return /\s/.test(before) !== /\s/.test(after) || (/[\s(]/.test(before) && /\S/.test(after)) || (/\S/.test(before) && /[\s).,:;!?]/.test(after))
}
