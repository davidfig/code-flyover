// Accurate syntax highlighting: Shiki, with VS Code's grammars. Each language's grammar is a file of its own, fetched
// the first time a file in that language is shown. It's about 30 times slower than the tokenizer in highlight.ts, so
// the layout worker (text/worker.ts) shows a file coloured by that one first and by this one once it's done.
//
// The theme below isn't one to look at: each of its colours stands for a token kind, and layout.ts picks real ones.

import { createShikiPrimitiveAsync, type ShikiPrimitive } from '@shikijs/primitive'
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma'
import type { LanguageRegistration } from '@shikijs/types'
import type { Token, Tokenizer, TokenKind } from './highlight.ts'

type Load = () => Promise<{ default: LanguageRegistration[] }>

/** Which files use which grammar; the first match wins. A path none matches keeps the plain tokenizer. */
const GRAMMARS: [RegExp, string, Load][] = [
  [/\.(ts|mts|cts)$/, 'typescript', () => import('@shikijs/langs/typescript')],
  [/\.(tsx|jsx|js|mjs|cjs)$/, 'tsx', () => import('@shikijs/langs/tsx')],
  [/\.rs$/, 'rust', () => import('@shikijs/langs/rust')],
  [/\.(py|pyi|pyw)$/, 'python', () => import('@shikijs/langs/python')],
  [/\.(cs|csx)$/, 'csharp', () => import('@shikijs/langs/csharp')],
  [/\.java$/, 'java', () => import('@shikijs/langs/java')],
  [/\.(kt|kts)$/, 'kotlin', () => import('@shikijs/langs/kotlin')],
  [/\.(scala|sc|sbt)$/, 'scala', () => import('@shikijs/langs/scala')],
  [/\.go$/, 'go', () => import('@shikijs/langs/go')],
  [/\.swift$/, 'swift', () => import('@shikijs/langs/swift')],
  [/\.(m|mm)$/, 'objective-c', () => import('@shikijs/langs/objective-c')],
  [/\.c$/, 'c', () => import('@shikijs/langs/c')],
  [/\.(h|cc|cpp|cxx|hh|hpp|hxx|inl|ipp)$/, 'cpp', () => import('@shikijs/langs/cpp')],
  [/\.(php|phtml)$/, 'php', () => import('@shikijs/langs/php')],
  [/(\.(rb|rake|gemspec|ru)|(^|\/)(Gemfile|Rakefile|Guardfile|Podfile|Fastfile|Vagrantfile|Brewfile))$/, 'ruby', () => import('@shikijs/langs/ruby')],
  [/\.dart$/, 'dart', () => import('@shikijs/langs/dart')],
  [/\.lua$/, 'lua', () => import('@shikijs/langs/lua')],
  [/\.(sh|bash|zsh|ksh)$/, 'shellscript', () => import('@shikijs/langs/shellscript')],
  [/\.(ps1|psm1|psd1)$/, 'powershell', () => import('@shikijs/langs/powershell')],
  [/\.(ex|exs)$/, 'elixir', () => import('@shikijs/langs/elixir')],
  [/\.(erl|hrl)$/, 'erlang', () => import('@shikijs/langs/erlang')],
  [/\.hs$/, 'haskell', () => import('@shikijs/langs/haskell')],
  [/\.(ml|mli)$/, 'ocaml', () => import('@shikijs/langs/ocaml')],
  [/\.(clj|cljs|cljc|edn)$/, 'clojure', () => import('@shikijs/langs/clojure')],
  [/\.r$/i, 'r', () => import('@shikijs/langs/r')],
  [/\.jl$/, 'julia', () => import('@shikijs/langs/julia')],
  [/\.zig$/, 'zig', () => import('@shikijs/langs/zig')],
  [/\.nim$/, 'nim', () => import('@shikijs/langs/nim')],
  [/\.(pl|pm)$/, 'perl', () => import('@shikijs/langs/perl')],
  [/\.(groovy|gradle)$/, 'groovy', () => import('@shikijs/langs/groovy')],
  [/\.(sql|psql|ddl)$/i, 'sql', () => import('@shikijs/langs/sql')],
  [/\.vue$/, 'vue', () => import('@shikijs/langs/vue')],
  [/\.svelte$/, 'svelte', () => import('@shikijs/langs/svelte')],
  [/\.astro$/, 'astro', () => import('@shikijs/langs/astro')],
  [/\.(css|pcss)$/, 'css', () => import('@shikijs/langs/css')],
  [/\.scss$/, 'scss', () => import('@shikijs/langs/scss')],
  [/\.(html|htm|xhtml)$/, 'html', () => import('@shikijs/langs/html')],
  [/\.(xml|xsl|xslt|xaml|csproj|vbproj|fsproj|props|targets|plist|storyboard|xib)$/, 'xml', () => import('@shikijs/langs/xml')],
  [/\.(json|jsonc|json5|geojson|webmanifest|ipynb)$/, 'jsonc', () => import('@shikijs/langs/jsonc')],
  [/\.ya?ml$/, 'yaml', () => import('@shikijs/langs/yaml')],
  [/\.toml$/, 'toml', () => import('@shikijs/langs/toml')],
  [/((^|\/)(GNUmakefile|[Mm]akefile)|\.(mk|make))$/, 'make', () => import('@shikijs/langs/make')],
  [/((^|\/)(Dockerfile|Containerfile)|\.dockerfile)$/, 'docker', () => import('@shikijs/langs/docker')],
  [/\.(tf|tfvars|hcl)$/, 'terraform', () => import('@shikijs/langs/terraform')],
]

/** A line longer than this (minified code, data) keeps the plain tokenizer's one-token cost. */
const LONG_LINE = 1000
/** The most time one line may take, ms; what's left of it stays plain. */
const LINE_MS = 100

// `name` is a plain identifier: coloured as a type where it's written like one (Deck, XmlElement).
const COLOR: Record<TokenKind | 'name', string> = {
  plain: '#000001',
  keyword: '#000002',
  string: '#000003',
  comment: '#000004',
  number: '#000005',
  type: '#000006',
  punct: '#000007',
  name: '#000008',
}

const rule = (kind: keyof typeof COLOR, ...scope: string[]) => ({ scope, settings: { foreground: COLOR[kind] } })

// A more specific scope wins over a shorter one, wherever it's listed.
const THEME = {
  name: 'kinds',
  type: 'light' as const,
  fg: COLOR.plain,
  bg: '#ffffff',
  settings: [
    { settings: { foreground: COLOR.plain, background: '#ffffff' } },
    rule('punct', 'punctuation', 'meta.brace', 'keyword.operator'),
    rule('keyword', 'keyword', 'storage', 'constant.language', 'variable.language', 'entity.name.tag', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.word', 'keyword.operator.logical.python', 'markup.heading'),
    rule('string', 'string', 'constant.character', 'punctuation.definition.string', 'markup.inline.raw', 'string.regexp punctuation', 'string.regexp keyword', 'string.regexp constant', 'string.regexp keyword.operator', 'string.regexp variable'),
    rule('plain', 'meta.template.expression', 'meta.embedded', 'meta.interpolation', 'string.unquoted.plain.out.yaml'),
    rule('punct', 'punctuation.definition.template-expression', 'punctuation.section.embedded', 'storage.type.function.arrow', 'punctuation.definition.interpolation'),
    rule('number', 'constant.numeric', 'keyword.other.unit'),
    rule('type', 'entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'entity.name.namespace', 'support.class', 'support.type', 'storage.type.java', 'storage.type.cs', 'entity.other.attribute-name', 'support.type.property-name'),
    rule('name', 'variable', 'entity.name.function', 'meta.definition.variable', 'meta.object-literal.key', 'support.variable', 'support.function', 'support.constant'),
    rule('keyword', 'variable.language'),
    rule('comment', 'comment', 'punctuation.definition.comment', 'string.quoted.docstring', 'string.quoted.docstring punctuation', 'comment keyword', 'comment storage', 'comment variable', 'comment entity'),
  ],
}

let primitive: Promise<ShikiPrimitive> | null = null
const shiki = () =>
  (primitive ??= createShikiPrimitiveAsync({
    themes: [THEME],
    langs: [],
    engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
  }))

const loaded = new Map<string, Promise<Tokenizer | null>>()

/** The grammar's tokenizer for a path, fetched on first use; null where there's none or it won't load. */
export function grammarFor(path: string): Promise<Tokenizer | null> | null {
  const g = GRAMMARS.find(([match]) => match.test(path))
  if (!g) return null
  const [, name, load] = g
  let t = loaded.get(name)
  if (!t) {
    t = make(name, load).catch((e) => {
      console.warn(`No ${name} grammar`, e)
      return null
    })
    loaded.set(name, t)
  }
  return t
}

async function make(name: string, load: Load): Promise<Tokenizer> {
  const [s, lang] = await Promise.all([shiki(), load()])
  await s.loadLanguage(lang.default)
  const { colorMap } = s.setTheme('kinds')
  const grammar = s.getLanguage(name)
  const kinds = colorMap.map((c) => (Object.keys(COLOR) as (keyof typeof COLOR)[]).find((k) => COLOR[k] === c?.toLowerCase()) ?? 'plain')
  return {
    line(text, state) {
      const stack = state.in === 'grammar' ? state.stack : null
      if (text.length > LONG_LINE) return { tokens: [{ kind: 'plain', text }], state }
      const r = grammar.tokenizeLine2(text, stack, LINE_MS)
      const tokens: Token[] = []
      for (let i = 0; i < r.tokens.length; i += 2) {
        const s = text.slice(r.tokens[i], r.tokens[i + 2] ?? text.length)
        if (!s) continue
        // The foreground colour's index: bits 15 to 23 (vscode-textmate's EncodedTokenAttributes).
        const k = kinds[(r.tokens[i + 1] >>> 15) & 0x1ff]
        const kind: TokenKind = k === 'name' ? (/^[A-Z][a-z0-9]/.test(s) ? 'type' : 'plain') : k
        const last = tokens[tokens.length - 1]
        if (last?.kind === kind) last.text += s
        else tokens.push({ kind, text: s })
      }
      return { tokens, state: { in: 'grammar', stack: r.ruleStack } }
    },
  }
}
