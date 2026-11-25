// The languages Code Flyover knows: which files are which, and how to colour them.
//
// The analyzer finds dependencies for the languages marked `deps` (analyzer/deps.ts and analyzer/langs/). Any other
// text file is still on the map: it's coloured with the syntax listed here, or as plain text if it isn't listed, and
// its dependencies are the repo files it names in quotes (analyzer/langs/fallback.ts).

export interface Syntax {
  /** space-separated */
  keywords: string
  /** characters that open a string */
  quotes: string
  /** which of `quotes` may run across lines */
  multiline?: string
  /** `"""` and `'''` strings, which run across lines */
  triple?: boolean
  /** has `/…/` regex literals */
  regex?: boolean
  /** line comment markers */
  line?: string[]
  /** block comment delimiters */
  block?: [string, string]
}

export interface LanguageDef {
  id: string
  name: string
  /** matched against the whole path */
  match: RegExp
  /** the analyzer finds this language's dependencies itself, not just the paths it quotes */
  deps?: boolean
  /** a programming language, not data or config: counts toward "source changed without tests" */
  code?: boolean
  syntax: Syntax
}

const C_COMMENTS = { line: ['//'], block: ['/*', '*/'] as [string, string] }
const HASH = { line: ['#'] }

const C_FAMILY =
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr'
const CPP =
  ' alignas alignof and asm catch class constexpr consteval constinit concept co_await co_return co_yield decltype delete dynamic_cast explicit export friend mutable namespace new noexcept not operator or private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw try typeid typename using virtual override final'
const PREPROCESSOR = ' include define undef ifdef ifndef elif endif pragma import'

export const LANGUAGES: LanguageDef[] = [
  {
    id: 'ts',
    name: 'TypeScript/JavaScript',
    match: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield',
      quotes: '"\'`',
      multiline: '`',
      regex: true,
      ...C_COMMENTS,
    },
  },
  {
    id: 'rust',
    name: 'Rust',
    match: /\.rs$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
      quotes: '"',
      multiline: '"',
      ...C_COMMENTS,
    },
  },
  {
    id: 'python',
    name: 'Python',
    match: /\.(py|pyi|pyw)$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield',
      quotes: '"\'',
      triple: true,
      ...HASH,
    },
  },
  {
    id: 'csharp',
    name: 'C#',
    match: /\.(cs|csx)$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get global goto if implicit in init int interface internal is lock long namespace new null object operator out override params partial private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using value var virtual void volatile when where while with yield',
      quotes: '"\'',
      ...C_COMMENTS,
    },
  },
  {
    id: 'java',
    name: 'Java',
    match: /\.java$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for goto if implements import instanceof int interface long native new null package permits private protected public record return sealed short static strictfp super switch synchronized this throw throws transient true try var void volatile while yield',
      quotes: '"\'',
      triple: true,
      ...C_COMMENTS,
    },
  },
  {
    id: 'kotlin',
    name: 'Kotlin',
    match: /\.(kt|kts)$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract actual annotation as break by catch class companion const constructor continue crossinline data do else enum expect external false final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package private protected public reified return sealed set super suspend tailrec this throw true try typealias val var vararg when where while',
      quotes: '"\'',
      triple: true,
      ...C_COMMENTS,
    },
  },
  {
    id: 'scala',
    name: 'Scala',
    match: /\.(scala|sc)$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract case catch class def do else enum export extends false final finally for forSome given if implicit import lazy match new null object override package private protected return sealed super then this throw trait true try type using val var while with yield',
      quotes: '"\'',
      triple: true,
      ...C_COMMENTS,
    },
  },
  {
    id: 'go',
    name: 'Go',
    match: /\.go$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'break case chan const continue default defer else fallthrough false for func go goto if import interface iota map nil package range return select struct switch true type var',
      quotes: '"\'`',
      multiline: '`',
      ...C_COMMENTS,
    },
  },
  {
    id: 'swift',
    name: 'Swift',
    match: /\.swift$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'actor any as associatedtype async await break case catch class continue convenience default defer deinit didSet do else enum extension fallthrough false fileprivate final for func get guard if import in indirect init inout internal is lazy let mutating nil nonisolated open operator override private protocol public repeat required rethrows return self Self set some static struct subscript super switch throw throws true try typealias var weak where while willSet',
      quotes: '"',
      triple: true,
      ...C_COMMENTS,
    },
  },
  {
    id: 'c',
    name: 'C/C++/Objective-C',
    match: /\.(c|h|cc|cpp|cxx|c\+\+|hh|hpp|hxx|h\+\+|ipp|inl|tpp|m|mm|cu|cuh)$/,
    deps: true,
    code: true,
    syntax: { keywords: C_FAMILY + CPP + PREPROCESSOR + ' @interface @implementation @end @property self nil YES NO', quotes: '"\'', ...C_COMMENTS },
  },
  {
    id: 'php',
    name: 'PHP',
    match: /\.(php|phtml)$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enum extends false final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true try unset use var while yield',
      quotes: '"\'',
      multiline: '"\'',
      line: ['//', '#'],
      block: ['/*', '*/'],
    },
  },
  {
    id: 'ruby',
    name: 'Ruby',
    match: /(\.(rb|rake|gemspec|ru)|(^|\/)(Gemfile|Rakefile|Guardfile|Podfile|Fastfile))$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_reader attr_writer attr_accessor private protected public',
      quotes: '"\'',
      multiline: '"\'',
      regex: true,
      ...HASH,
    },
  },
  {
    id: 'dart',
    name: 'Dart',
    match: /\.dart$/,
    deps: true,
    code: true,
    syntax: {
      keywords:
        'abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try typedef var void when while with yield',
      quotes: '"\'',
      triple: true,
      ...C_COMMENTS,
    },
  },
  {
    id: 'lua',
    name: 'Lua',
    match: /\.lua$/,
    deps: true,
    code: true,
    syntax: {
      keywords: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while require',
      quotes: '"\'',
      line: ['--'],
    },
  },

  // Coloured, and on the map with the fallback's dependencies (the repo files they quote).
  {
    id: 'shell',
    name: 'Shell',
    match: /(\.(sh|bash|zsh|fish|ksh)|(^|\/)(\.bashrc|\.zshrc|\.profile))$/,
    code: true,
    syntax: {
      keywords: 'if then else elif fi case esac for while until do done in function return local export readonly declare unset source set shift exit break continue true false echo',
      quotes: '"\'',
      multiline: '"\'',
      ...HASH,
    },
  },
  {
    id: 'powershell',
    name: 'PowerShell',
    match: /\.(ps1|psm1|psd1)$/,
    code: true,
    syntax: {
      keywords: 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while',
      quotes: '"\'',
      line: ['#'],
      block: ['<#', '#>'],
    },
  },
  {
    id: 'elixir',
    name: 'Elixir',
    match: /\.(ex|exs)$/,
    code: true,
    syntax: { keywords: 'after alias and catch cond def defmacro defmodule defp defprotocol defimpl defstruct do else end false fn for if import in nil not or quote raise receive require rescue true try unless use when with', quotes: '"\'', triple: true, ...HASH },
  },
  {
    id: 'erlang',
    name: 'Erlang',
    match: /\.(erl|hrl)$/,
    code: true,
    syntax: { keywords: 'after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not of or orelse receive rem try when xor', quotes: '"', line: ['%'] },
  },
  {
    id: 'haskell',
    name: 'Haskell',
    match: /\.(hs|lhs)$/,
    code: true,
    syntax: { keywords: 'case class data default deriving do else family forall foreign if import in infix infixl infixr instance let module newtype of qualified then type where', quotes: '"', line: ['--'], block: ['{-', '-}'] },
  },
  {
    id: 'ocaml',
    name: 'OCaml/F#',
    match: /\.(ml|mli|fs|fsi|fsx)$/,
    code: true,
    syntax: { keywords: 'and as begin class do done downto else end exception false for fun function functor if in include inherit let match member method module mutable namespace new not of open or rec sig struct then to true try type val when while with', quotes: '"', line: ['//'], block: ['(*', '*)'] },
  },
  {
    id: 'clojure',
    name: 'Clojure/Lisp',
    match: /\.(clj|cljs|cljc|edn|lisp|el|scm|rkt)$/,
    code: true,
    syntax: { keywords: 'def defn defmacro defrecord defprotocol defmulti defmethod fn let if do when cond loop recur ns require import lambda define', quotes: '"', line: [';'] },
  },
  {
    id: 'r',
    name: 'R',
    match: /\.(r|R|Rmd)$/,
    code: true,
    syntax: { keywords: 'if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library require source return', quotes: '"\'', ...HASH },
  },
  {
    id: 'julia',
    name: 'Julia',
    match: /\.jl$/,
    code: true,
    syntax: { keywords: 'abstract begin break catch const continue do else elseif end export false finally for function global if import in let local macro module mutable quote return struct true try type using while', quotes: '"', triple: true, line: ['#'], block: ['#=', '=#'] },
  },
  {
    id: 'zig',
    name: 'Zig',
    match: /\.zig$/,
    code: true,
    syntax: { keywords: 'addrspace align allowzero and anyframe anytype asm async await break catch comptime const continue defer else enum errdefer error export extern false fn for if inline noalias nosuspend null opaque or orelse packed pub resume return struct suspend switch test threadlocal true try undefined union unreachable usingnamespace var volatile while', quotes: '"\'', line: ['//'] },
  },
  {
    id: 'nim',
    name: 'Nim',
    match: /\.nim$/,
    code: true,
    syntax: { keywords: 'addr and as asm bind block break case cast concept const continue converter defer discard distinct div do elif else end enum except export finally for from func if import in include interface is isnot iterator let macro method mixin mod nil not notin object of or out proc ptr raise ref return shl shr static template try tuple type using var when while xor yield', quotes: '"\'', triple: true, ...HASH },
  },
  {
    id: 'perl',
    name: 'Perl',
    match: /\.(pl|pm|t)$/,
    code: true,
    syntax: { keywords: 'my our local sub if elsif else unless while until for foreach last next redo return use require package do eval', quotes: '"\'', multiline: '"\'', ...HASH },
  },
  {
    id: 'groovy',
    name: 'Groovy/Gradle',
    match: /\.(groovy|gradle)$/,
    code: true,
    syntax: { keywords: 'abstract as assert boolean break case catch class def default do else enum extends false final finally for if implements import in instanceof interface new null package private protected public return static super switch this throw true try void while', quotes: '"\'', triple: true, ...C_COMMENTS },
  },
  {
    id: 'sql',
    name: 'SQL',
    match: /\.(sql|psql|ddl)$/i,
    code: true,
    syntax: {
      keywords:
        'ADD ALL ALTER AND AS ASC BEGIN BETWEEN BY CASE CHECK COLUMN COMMIT CONSTRAINT CREATE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXISTS FOREIGN FROM FUNCTION GROUP HAVING IF IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL ON OR ORDER OUTER PRIMARY REFERENCES RETURNS RIGHT ROLLBACK SELECT SET TABLE THEN TRIGGER UNION UNIQUE UPDATE VALUES VIEW WHEN WHERE WITH add all alter and as asc begin between by case check column commit constraint create default delete desc distinct drop else end exists foreign from function group having if in index inner insert into is join key left like limit not null on or order outer primary references returns right rollback select set table then trigger union unique update values view when where with',
      quotes: '\'"',
      line: ['--'],
      block: ['/*', '*/'],
    },
  },
  {
    id: 'vue',
    name: 'Vue/Svelte/Astro',
    match: /\.(vue|svelte|astro)$/,
    deps: true,
    code: true,
    syntax: { keywords: 'import export from default const let var function return if else for of in new class this true false null undefined async await template script style', quotes: '"\'`', multiline: '`', regex: true, line: ['//'], block: ['/*', '*/'] },
  },
  {
    id: 'css',
    name: 'CSS',
    match: /\.(css|scss|sass|less|styl|pcss)$/,
    code: true,
    syntax: { keywords: '@import @media @supports @keyframes @font-face @layer @use @forward @mixin @include @extend !important', quotes: '"\'', block: ['/*', '*/'] },
  },
  {
    id: 'html',
    name: 'HTML/XML',
    match: /\.(html|htm|xhtml|xml|xsl|xslt|xaml|csproj|vbproj|fsproj|props|targets|plist|svelte\.html|jsp|erb|hbs|handlebars|mustache|njk|liquid|j2|jinja|razor|cshtml|storyboard|xib)$/,
    syntax: { keywords: '', quotes: '"\'', block: ['<!--', '-->'] },
  },
  {
    id: 'json',
    name: 'JSON',
    match: /\.(json|jsonc|json5|geojson|webmanifest|ipynb)$|(^|\/)\.(babelrc|eslintrc|prettierrc)$/,
    syntax: { keywords: 'true false null', quotes: '"', line: ['//'], block: ['/*', '*/'] },
  },
  {
    id: 'yaml',
    name: 'YAML/TOML/INI',
    match: /\.(ya?ml|toml|ini|cfg|conf|properties|env|editorconfig)$|(^|\/)(\.env[\w.-]*|\.gitignore|\.gitattributes|\.dockerignore|\.npmignore|\.npmrc|\.nvmrc|CODEOWNERS)$/,
    syntax: { keywords: 'true false null yes no on off', quotes: '"\'', ...HASH },
  },
  {
    id: 'make',
    name: 'Make/CMake/Docker',
    match: /(^|\/)(Makefile|GNUmakefile|makefile|Dockerfile|Containerfile|Justfile|justfile|Procfile|Brewfile|Vagrantfile|CMakeLists\.txt)$|\.(mk|make|cmake|dockerfile|bazel|bzl|nix|tf|tfvars|hcl)$|(^|\/)(BUILD|WORKSPACE)$/,
    syntax: {
      keywords:
        'FROM RUN CMD COPY ADD ENV ARG WORKDIR EXPOSE ENTRYPOINT USER VOLUME LABEL HEALTHCHECK SHELL ONBUILD STOPSIGNAL AS ifeq ifneq ifdef ifndef else endif include define endef export override project add_executable add_library target_link_libraries find_package set if endif foreach endforeach function endfunction resource variable module provider data output locals terraform let in rec with inherit import',
      quotes: '"\'',
      ...HASH,
    },
  },
]

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]))

/** The language a path is in, or undefined for a file we only show as plain text. */
export function languageOf(path: string): LanguageDef | undefined {
  for (const l of LANGUAGES) if (l.match.test(path)) return l
  return undefined
}

export function languageById(id: string): LanguageDef | undefined {
  return BY_ID.get(id)
}

/** Files that are never text worth showing: images, media, fonts, archives, binaries, source maps. */
export const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|ai|sketch|fig|xcf|heic|svg|svgz|eps|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|ear|aar|apk|aab|ipa|dmg|pkg|msi|iso|deb|rpm|exe|dll|so|dylib|a|o|obj|lib|pdb|class|pyc|pyo|whl|egg|wasm|node|bin|dat|db|sqlite3?|mdb|woff2?|ttf|otf|eot|mp3|mp4|m4a|m4v|wav|ogg|oga|flac|aac|mov|avi|mkv|webm|wmv|flv|glb|gltf|fbx|blend|3ds|stl|ply|usdz|ktx2?|dds|exr|hdr|keystore|jks|p12|pfx|der|cer|crt|mobileprovision|nib|car|xcassets|lockb|map|DS_Store)$/i
