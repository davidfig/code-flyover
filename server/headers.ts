// What a file says it is for, in its own opening comment, in any of the common languages: shown on hovering a file's
// name when a review hasn't left a current note for it (server/notes.ts), and given to the AI as evidence
// (server/review-cli.ts). And what a folder says it is, in its README or its index file's opening comment.

import { listFiles, readFiles } from '../analyzer/git.ts'
import type { Analysis } from '../shared/types.ts'

/** How a family of languages writes comments, and what may come before the one that describes the file. */
interface Style {
  /** matched against the file's name */
  match: RegExp
  line?: string[]
  block?: [string, string][]
  /** lines of code that may stand above the description (package, imports, include guards), when it may */
  preamble?: RegExp
  /** a doc comment on the file's type or module is the file's description: Java's class comment, say */
  docOnType?: boolean
}

const C: [string, string] = ['/*', '*/']
const HTML: [string, string] = ['<!--', '-->']
const C_PREAMBLE = /^(#\s*(pragma|include|ifndef|ifdef|if|define|endif|import)\b|@import\b|extern "C"|using namespace\b|module;|import\b|export module\b)/
const CLASSY_PREAMBLE = /^(package|import|using|global using|namespace|open|@file:|@testable import|library|part|export|module|#if|#endif|#nullable|#region|\[assembly:)(?=\W|$)/

const STYLES: Style[] = [
  { match: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, line: ['//'], block: [C], preamble: /^['"]use \w+['"]/ },
  { match: /\.(java|kt|kts|scala|sc|groovy|gradle|cs|csx|swift|dart)$/i, line: ['//'], block: [C], preamble: CLASSY_PREAMBLE, docOnType: true },
  { match: /\.(php|phtml)$/i, line: ['//', '#'], block: [C], preamble: /^(<\?php|<\?|\?>|declare\s*\(|namespace\b|use\b|require|include|if\s*\(\s*!\s*defined)/, docOnType: true },
  { match: /\.(c|h|cc|cpp|cxx|hh|hpp|hxx|inl|ipp|m|mm|ino|cu|glsl|vert|frag|comp|hlsl|wgsl|metal|cppm|ixx)$/i, line: ['//'], block: [C], preamble: C_PREAMBLE },
  { match: /\.(go|rs|proto|sol|zig|thrift|v|sv|svh|d|odin|jsonc|json5|prisma|styl|less|scss|sass|css|pcss|jai|cue|bicep|as|hx|vala|qml)$/i, line: ['//'], block: [C], preamble: /^(syntax\s*=|pragma solidity|package\b|@charset|#!\[)/ },
  { match: /\.(tf|tfvars|hcl|nix)$/i, line: ['#', '//'], block: [C] },
  { match: /\.(fs|fsx|fsi)$/i, line: ['//'], block: [['(*', '*)']], preamble: /^(module|namespace|open)\b/, docOnType: true },
  { match: /\.(py|pyi|pyw|pyx|bzl|star)$|(^|\/)(BUILD|WORKSPACE|SConstruct)(\.bazel)?$/i, line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], preamble: /^from __future__\b/ },
  { match: /\.(rb|rake|gemspec|cr|ru)$|(^|\/)(Rakefile|Gemfile|Podfile|Vagrantfile|Fastfile)$/i, line: ['#'], block: [['=begin', '=end']], preamble: /^(require|require_relative|module|using)\b/, docOnType: true },
  { match: /\.(pl|pm|t|raku)$/i, line: ['#'], block: [['=pod', '=cut'], ['=head1', '=cut']], preamble: /^(package|use)\b/ },
  { match: /\.(exs?)$/i, line: ['#'], block: [['@moduledoc """', '"""']], preamble: /^defmodule\b/ },
  { match: /\.(ps1|psm1|psd1)$/i, line: ['#'], block: [['<#', '#>']], preamble: /^(using|#Requires)\b/i },
  { match: /\.jl$/i, line: ['#'], block: [['#=', '=#'], ['"""', '"""']], preamble: /^module\b/ },
  { match: /\.nim$/i, line: ['##', '#'], block: [['#[', ']#']] },
  { match: /\.coffee$/i, line: ['#'], block: [['###', '###']] },
  { match: /\.cmake$|(^|\/)CMakeLists\.txt$/i, line: ['#'], block: [['#[[', ']]']], preamble: /^cmake_minimum_required/i },
  { match: /\.(sh|bash|zsh|fish|ksh|r|ya?ml|toml|conf|cfg|properties|awk|sed|tcl|mk|make|graphql|gql|gd|dockerfile|env|just|bats|feature|rego)$|(^|\/)(Dockerfile|Makefile|GNUmakefile|Justfile|Containerfile|Caddyfile)[^/]*$|(^|\/)\.(gitignore|dockerignore|editorconfig|env)[^/]*$/i, line: ['#'], preamble: /^---$/ },
  { match: /\.(sql|psql|pgsql|ddl)$/i, line: ['--'], block: [C] },
  { match: /\.lua$/i, line: ['--'], block: [['--[[', ']]'], ['--[==[', ']==]'], ['--[=[', ']=]']] },
  { match: /\.(hs|lhs|elm|purs|idr|agda)$/i, line: ['--'], block: [['{-', '-}']], preamble: /^(module|import|port module)\b|^\{-#/ },
  { match: /\.(ada|adb|ads|vhd|vhdl)$/i, line: ['--'], preamble: /^(with|use|library)\b/i },
  { match: /\.applescript$/i, line: ['--', '#'], block: [['(*', '*)']] },
  { match: /\.(ml|mli)$/i, block: [['(*', '*)']], preamble: /^open\b/ },
  { match: /\.(pas|pp|dpr)$/i, line: ['//'], block: [['{', '}'], ['(*', '*)']], preamble: /^(unit|program|library)\b/i },
  { match: /\.(clj|cljs|cljc|edn|lisp|cl|el|scm|ss|rkt|asm|s|nasm|ini|fnl)$/i, line: [';'], block: [['#|', '|#']], preamble: /^#lang\b/ },
  { match: /\.(erl|hrl|tex|sty|cls|bib|pro|prolog)$/i, line: ['%'], preamble: /^-module\b/ },
  { match: /\.mlx?$/i, line: ['%'], block: [['%{', '%}']] },
  { match: /\.(vb|vbs|bas|vba)$/i, line: ["'"], preamble: /^(imports|option|attribute|namespace)\b/i, docOnType: true },
  { match: /\.(bat|cmd)$/i, line: ['::', 'REM ', 'rem ', '@REM ', '@rem '], preamble: /^@?echo off/i },
  { match: /\.(f|for|f90|f95|f03|f08)$/i, line: ['!'] },
  { match: /\.vim$/i, line: ['"'] },
  { match: /\.(vue|svelte|astro)$/i, line: ['//'], block: [HTML, C], preamble: /^(<script\b[^>]*>$|---$|import\b)/ },
  { match: /\.(html?|xhtml|xml|xsl|xslt|xsd|svg|xaml|csproj|fsproj|vbproj|props|targets|plist|md|mdx|markdown)$/i, block: [HTML], preamble: /^(<!doctype|<\?xml|<html|<head|<meta|---$)/i },
  { match: /\.(erb|ejs)$/i, block: [['<%#', '%>'], HTML] },
  { match: /\.(hbs|handlebars|mustache)$/i, block: [['{{!--', '--}}'], ['{{!', '}}'], HTML] },
  { match: /\.(jinja2?|j2|twig|njk|liquid)$/i, block: [['{#', '#}'], HTML] },
  { match: /\.(cshtml|razor)$/i, block: [['@*', '*@'], HTML], preamble: /^@(page|using|model|namespace|inject)\b/ },
  { match: /\.(pug|jade)$/i, line: ['//-', '//'] },
  { match: /\.haml$/i, line: ['-#'] },
]

/** How far into a file its description may start, in lines, and how many lines of one comment are read. */
const SCAN = 150
const READ = 60

/** A paragraph about the licence or the tools, not about the file. */
const LEGAL =
  /SPDX-License|\bcopyright\s*(\(c\)|©|\d{4}|by\b|the\b|holders?\b|[A-Z]\w+ \d{4})|(\(c\)|©)\s*\d{4}|all rights reserved|licen[sc]ed (under|to)|permission is hereby granted|redistribution and use|this (program|library|software|file) is (free software|distributed|provided|part of)|GNU (Lesser |Affero )?General Public|without (even the implied )?warrant|you may (not use|obtain a copy)|unless required by applicable law|limitations under the license|use of this source code is governed|you should have received a copy|neither the name of|Mozilla Public License|the above copyright notice/i
/** One line of a licence notice, which the description may follow directly. */
const LEGAL_LINE = /^(SPDX-|(copyright\s*)?(\(c\)|©|copyright)\s*(\(c\)|©)?\s*\d{4})/i
/** A line for a tool or an editor, not for a reader. */
const DIRECTIVE =
  /^(eslint|@ts-|@jsx|@flow|@noflow|@format|@generated|@prettier|prettier|biome-|deno-|tslint|jshint|jslint|istanbul|c8 ignore|webpack|<reference|-\*-|vim:|ex:|coding[:=]|frozen_string_literal|typed:|syntax=|escape=|pylint|flake8|noqa|mypy|type:|ruff|isort|rubocop|shellcheck|yaml-language-server|\+build|go:|nolint|swiftlint|swift-tools-version|clang-format|clang-tidy|NOLINT|@(author|since|version|date|license|copyright|preserve|package|subpackage|category|link)\b|created (by|on) .*\d|(author|date):|file:\s*\S+$)/i

/** A comment's text: its lines without the markers, and where the file goes on after it. */
interface Comment {
  lines: string[]
  next: number
  /** a doc comment (`/**`, `///`, a docstring), which may belong to what follows it */
  doc: boolean
}

function commentAt(src: string[], at: number, style: Style): Comment | null {
  const first = src[at].trim()
  for (const [open, close] of style.block ?? []) {
    let rest = first
    // A Python docstring may have a prefix (r""", u""").
    if (open === '"""' || open === "'''") rest = rest.replace(/^[rRuUbB]{1,2}(?=["'])/, '')
    if (!rest.startsWith(open)) continue
    if (/^\{(\$|-#)/.test(rest)) continue // a compiler directive (Pascal, Haskell)
    rest = rest.slice(open.length)
    const doc = (open === '/*' && rest.startsWith('*')) || open.endsWith('"""')
    const lines: string[] = []
    for (let i = at; i < src.length; i++) {
      let l = i === at ? rest : src[i].trim()
      const end = l.indexOf(close)
      if (end >= 0) l = l.slice(0, end)
      if (open === '/*' || open === '(*') l = l.replace(/^[*!]+\s?/, '')
      else if (open === '{-' && i === at) l = l.replace(/^\s*\|/, '')
      if (lines.length < READ) lines.push(l.trim())
      if (end >= 0) return { lines, next: i + 1, doc }
    }
    return null // never closed: not a comment
  }
  const marker = style.line?.find((m) => lineText(first, m) !== null)
  if (marker === undefined) return null
  const lines: string[] = []
  let i = at
  for (; i < src.length; i++) {
    const t = lineText(src[i].trim(), marker)
    if (t === null) break
    if (lines.length < READ) lines.push(t)
  }
  return { lines, next: i, doc: /^\/\/[/](?!\/)/.test(first) }
}

/** The text of a line comment, or null if the line isn't one. A `#` or `--` right up against a word is code or a directive. */
function lineText(line: string, marker: string): string | null {
  if (!line.startsWith(marker)) return null
  const rest = line.slice(marker.length).replace(/^[/!#;%*'-]+(?=\s|$)/, '')
  if ((marker === '#' || marker === '--') && rest && !/^\s/.test(rest) && !/^[A-Z][a-z]*\s/.test(rest)) return null
  return rest.trim()
}

/** A comment's paragraphs that are about the file, each on one line. */
function prose(c: Comment, name: string): string[] {
  const stem = name.replace(/^.*\//, '')
  const out: string[] = []
  let para: string[] = []
  const flush = () => {
    const text = para.join(' ').trim()
    para = []
    // Two words are a title, not a description.
    if (text && !LEGAL.test(text) && text.split(/\s+/).length >= 3) out.push(text)
  }
  for (const raw of c.lines) {
    // Doc tags that hold the description lose the tag; any other tag starts the parameters and so on.
    let l = raw.replace(/^[@\\](file|fileoverview|overview|brief|module|description|summary|desc|details|namespace|class)\b:?\s*/i, '')
    l = l
      .replace(/<\/?(summary|remarks|para|p|b|i|em|strong|code|c|ul|ol|li|pre)\b[^>]*>/gi, ' ')
      .replace(/<see(?:also)? cref="(?:\w:)?([^"]*)"\s*\/>/gi, '$1')
      .replace(/\{@(?:link|code|linkplain|literal)\s+([^}]*)\}/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    // `foo.el --- Does this`, `Foo.swift`, `file.h: does this`: the file's own name says nothing here.
    if (l.startsWith(stem)) l = l.slice(stem.length).replace(/^\s*(-+|—|–|:)\s*/, '').trim()
    // A blank line, a rule of dashes or a tag ends the paragraph.
    if (!/[\p{L}\p{N}]/u.test(l) || LEGAL_LINE.test(l)) flush()
    else if (/^[@\\]\w/.test(l)) {
      flush()
      if (/^[@\\](param|return|returns|throws|example|see|type|typedef|property)\b/i.test(l)) break
    } else if (!DIRECTIVE.test(l)) {
      // PowerShell's and Perl's section names, above their text.
      if (/^\.(SYNOPSIS|DESCRIPTION)$/i.test(l) || l === 'NAME' || l === 'DESCRIPTION') flush()
      else para.push(l)
    }
  }
  flush()
  return out
}

const DECLARES = /^(export|declare|async|function|class|interface|type|const|let|var|enum|abstract|pub|fn|struct|impl|trait|static|mod|use|def|public|private|internal|final|unsafe)\b/
const TYPE = /^(?:(?:public|private|internal|protected|export|abstract|final|sealed|static|partial|open|data|case|readonly|fileprivate|base|mixin|implicit|Public|Friend|NotInheritable|MustInherit|unsafe|file|actual|expect|value|inner|enum|annotation)\s+)*(class|interface|struct|enum|record|object|trait|protocol|extension|actor|type|module|namespace|mixin|Class|Module|Structure|Interface)\b/

/** The paragraphs of the comment that describes a file, or none. */
function opening(text: string, name: string): string[] {
  const style = STYLES.find((s) => s.match.test(name))
  if (!style) return []
  // Only the start of a file is looked at; it can be very long.
  const src = text.slice(0, 24_000).replace(/^\uFEFF/, '').split(/\r?\n/)
  let inParens = false
  for (let i = 0; i < Math.min(src.length, SCAN); ) {
    const line = src[i].trim()
    if (!line || line.startsWith('#!') && !line.startsWith('#![')) {
      i++
      continue
    }
    // The rest of a Go, Dart or TypeScript list in parentheses or braces above the comment.
    if (inParens) {
      if (/[)}]/.test(line)) inParens = false
      i++
      continue
    }
    const c = commentAt(src, i, style)
    if (c) {
      const found = prose(c, name)
      if (found.length && mine(c, src, style, text)) return found
      i = c.next
      continue
    }
    // Attributes and annotations sit between a class and its imports.
    if (style.preamble?.test(line) || (style.docOnType && /^([@[]|\{$)/.test(line))) {
      if (/.[({]\s*$/.test(line) && !/^(module|namespace|defmodule|extern)\b/.test(line)) inParens = true
      i++
      continue
    }
    return []
  }
  return []
}

/** Whether a comment is about the file, not about the first thing declared in it. */
function mine(c: Comment, src: string[], style: Style, text: string): boolean {
  let i = c.next
  // Attributes, annotations and decorators go between a declaration and its comment.
  while (i < src.length && /^\s*(@\w|\[[A-Z]|#\[)/.test(src[i])) i++
  const after = src[i]?.trim() ?? ''
  if (!c.doc || !DECLARES.test(after)) return true
  if (style.docOnType) return TYPE.test(after)
  // In JavaScript and Rust a doc comment right above a declaration is that declaration's, unless it's all the file has.
  return (text.match(/^(export|pub)\b/gm)?.length ?? 0) <= 1
}

/** A file's opening comment, as one line (licence and tool lines left out), or ''. At most about `limit` characters. */
export function headerOf(text: string, name: string, limit = 320): string {
  const all = opening(text, name)[0] ?? ''
  return all.length > limit ? all.slice(0, limit - 1) + '…' : all
}

/** The opening comment as a tooltip shows it: its first sentences, as many as fit in a couple of lines. */
export function summaryOf(text: string, name: string): string {
  return shorten(headerOf(text, name, 1000))
}

function shorten(all: string): string {
  if (all.length <= 220) return all
  let out = ''
  for (const s of all.split(/(?<=[.!?]["')\]]?)\s+(?=["'`(\[]?[\p{Lu}\p{N}])|(?<=[。！？])/u)) {
    if (out && out.length + s.length + 1 > 220) break
    out += (out ? ' ' : '') + s
  }
  return out.length <= 300 ? out : out.slice(0, 297).replace(/\s+\S*$/, '') + '…'
}

/** The opening comments of the source and test files at an analysis's head, by path: those that have one. */
export function openingComments(a: Analysis, repoPath: string): Record<string, string> {
  const paths = a.files.filter((f) => f.status !== 'deleted' && (f.role === 'source' || f.role === 'test')).map((f) => f.path)
  const out: Record<string, string> = {}
  for (const [p, text] of readFiles(repoPath, a.headSha, paths)) {
    const s = summaryOf(text, p)
    if (s) out[p] = s
  }
  return out
}

/** A Markdown (or plain text) README's first paragraph of prose, without its markup, or ''. */
export function readmeSummary(text: string): string {
  const para: string[] = []
  const src = text.slice(0, 24_000).replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  let fence = false
  const done = () => {
    const t = para
      .join(' ')
      .replace(/!\[[^\]]*\](\([^)]*\)|\[[^\]]*\])/g, '')
      .replace(/\[\s*\](\([^)]*\)|\[[^\]]*\])/g, '')
      .replace(/\[([^\]]+)\](\([^)]*\)|\[[^\]]*\])/g, '$1')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    para.length = 0
    return /\p{L}/u.test(t) && t.split(' ').length >= 3 && !LEGAL.test(t) ? shorten(t.slice(0, 1000)) : ''
  }
  for (let i = 0; i < src.length; i++) {
    const l = src[i].trim()
    if (/^(```|~~~)/.test(l)) fence = !fence
    const heading = /^(#|=+$|-{2,}$|\*{3,}$)/.test(l)
    // Underlined headings: the line above the rule is the title.
    if (/^(=+|-{2,})$/.test(l)) para.length = 0
    if (!fence && l && !heading && !/^(```|~~~|[-*+]\s|\d+[.)]\s|>|\||\[[^\]]+\]:)/.test(l)) {
      para.push(l)
      continue
    }
    const t = done()
    if (t) return t
  }
  return done()
}

/** The files that speak for their folder, best first. */
const SPEAKS = [/^readme(\.(md|markdown|txt|rst))?$/i, /^package-info\.java$|^doc\.go$/, /^index\.([mc]?[jt]s|[jt]sx)$/, /^(mod|lib)\.rs$/, /^__init__\.py$/, /^init\.lua$/]

/** The file that says what each folder is, for those with one: its README, or else its index file. */
export function speakers(paths: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of paths) {
    const slash = p.lastIndexOf('/')
    if (slash < 0 || !SPEAKS.some((r) => r.test(p.slice(slash + 1)))) continue
    const dir = p.slice(0, slash)
    out.set(dir, [...(out.get(dir) ?? []), p])
  }
  const rank = (p: string) => SPEAKS.findIndex((r) => r.test(p.slice(p.lastIndexOf('/') + 1)))
  for (const list of out.values()) list.sort((x, y) => rank(x) - rank(y))
  return out
}

/** What the folders on an analysis's map say they are at its head, by path: those that do. */
export function folderComments(a: Analysis, repoPath: string): Record<string, { text: string; from: string }> {
  const onMap = new Set<string>()
  for (const f of a.files) for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) onMap.add(f.path.slice(0, i))
  const by = [...speakers(listFiles(repoPath, a.headSha))].filter(([dir]) => onMap.has(dir))
  const texts = readFiles(repoPath, a.headSha, by.flatMap(([, list]) => list))
  const out: Record<string, { text: string; from: string }> = {}
  for (const [dir, list] of by)
    for (const p of list) {
      const name = p.slice(dir.length + 1)
      const readme = SPEAKS[0].test(name)
      const src = texts.get(p) ?? ''
      // In Rust only `//!` is about the module; a plain comment there is about the code under it.
      const text = readme ? readmeSummary(src) : p.endsWith('.rs') && !/^\s*(\/\/!|\/\*!)/m.test(src) ? '' : summaryOf(src, p)
      if (!text) continue
      out[dir] = { text, from: readme ? name : `${name}'s opening comment` }
      break
    }
  return out
}
