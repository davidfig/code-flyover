// Syntax highlighting for diff lines: a small tokenizer, no library.
//
// A line becomes a list of tokens (keyword, string, comment, number, type, plain). State carries from line to
// line, so a block comment or a template string that spans lines stays coloured. It is deliberately simple; a
// better highlighter can replace `tokenizer()` without the renderer changing, since the renderer only sees tokens.

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'type' | 'punct'

export interface Token {
  kind: TokenKind
  text: string
}

export type Language = 'ts' | 'rust' | 'plain'

/** Where a line ends up: inside a block comment, or inside a multi-line string with this closing quote. */
export type LineState = { in: 'code' } | { in: 'comment' } | { in: 'string'; close: string }

export interface Tokenizer {
  line(text: string, state: LineState): { tokens: Token[]; state: LineState }
}

const TS_KEYWORDS = new Set(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield'.split(' '),
)
const RUST_KEYWORDS = new Set(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' '),
)

export function languageOf(path: string): Language {
  if (/\.[cm]?[jt]sx?$/.test(path)) return 'ts'
  if (/\.rs$/.test(path)) return 'rust'
  return 'plain'
}

export function tokenizer(lang: Language): Tokenizer {
  if (lang === 'plain') return { line: (text, state) => ({ tokens: [{ kind: 'plain', text }], state }) }
  const keywords = lang === 'rust' ? RUST_KEYWORDS : TS_KEYWORDS
  const quotes = lang === 'rust' ? '"' : '"\'`'
  // Strings that may run across lines: template literals in TS, any string in Rust.
  const multiline = lang === 'rust' ? '"' : '`'
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
      if (state.in === 'comment') {
        const end = text.indexOf('*/')
        if (end < 0) return { tokens: [{ kind: 'comment', text }], state }
        push('comment', text.slice(0, end + 2))
        i = end + 2
        state = { in: 'code' }
      } else if (state.in === 'string') {
        const end = closing(text, 0, state.close)
        if (end < 0) return { tokens: [{ kind: 'string', text }], state }
        push('string', text.slice(0, end + 1))
        i = end + 1
        state = { in: 'code' }
      }
      while (i < text.length) {
        const c = text[i]
        const rest = text.slice(i)
        if (rest.startsWith('//')) {
          push('comment', rest)
          break
        }
        if (rest.startsWith('/*')) {
          const end = text.indexOf('*/', i + 2)
          if (end < 0) {
            push('comment', rest)
            state = { in: 'comment' }
            break
          }
          push('comment', text.slice(i, end + 2))
          i = end + 2
          continue
        }
        if (quotes.includes(c)) {
          const end = closing(text, i + 1, c)
          if (end < 0) {
            push('string', rest)
            if (multiline.includes(c)) state = { in: 'string', close: c }
            break
          }
          push('string', text.slice(i, end + 1))
          i = end + 1
          continue
        }
        const num = /^(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)n?/i.exec(rest)
        if (num && !/[\w$]/.test(text[i - 1] ?? '')) {
          push('number', num[0])
          i += num[0].length
          continue
        }
        const word = /^[A-Za-z_$][\w$]*/.exec(rest)
        if (word) {
          const w = word[0]
          push(keywords.has(w) ? 'keyword' : /^[A-Z][a-z0-9]/.test(w) ? 'type' : 'plain', w)
          i += w.length
          continue
        }
        push(/[{}()[\];,.<>=+\-*/%!&|^~?:]/.test(c) ? 'punct' : 'plain', c)
        i++
      }
      return { tokens, state }
    },
  }
}

/** Index of the closing quote at or after `from`, skipping escaped ones; -1 if the line ends first. */
function closing(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === quote) return i
  }
  return -1
}
