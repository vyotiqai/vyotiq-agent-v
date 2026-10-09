import { useEffect, useRef, useState } from 'react'
import type { GrammarState, HighlighterCore, ThemeRegistration } from 'shiki/core'

/*
  Code colours for replies.

  The theme is the app's own: every scope resolves to a `--vy-syntax-*`
  token, so a code block follows all five skins and both themes the way the
  editor does — no GitHub hex, no re-highlight when the theme flips.

  While a fence streams, finished lines are coloured as they land: each new
  line continues from the grammar state the last one ended in, so the cost
  of a tick is the new lines only, never the whole block again.
*/

const v = (name: string): string => `var(--vy-syntax-${name})`

const THEME: ThemeRegistration = {
  name: 'vy',
  type: 'dark',
  fg: 'var(--vy-fg)',
  bg: 'transparent',
  settings: [
    { settings: { foreground: 'var(--vy-fg)' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: v('comment'), fontStyle: 'italic' } },
    { scope: ['string', 'string.template', 'punctuation.definition.string', 'markup.inline.raw'], settings: { foreground: v('string') } },
    { scope: ['constant.numeric', 'constant.language.boolean', 'constant.language.null', 'constant.language.undefined'], settings: { foreground: v('number') } },
    { scope: ['constant', 'variable.other.constant', 'variable.other.enummember', 'support.constant'], settings: { foreground: v('constant') } },
    { scope: ['constant.character.escape', 'string.regexp'], settings: { foreground: v('escape') } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.control', 'variable.language'],
      settings: { foreground: v('keyword') }
    },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: v('func') } },
    {
      scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'entity.name.tag', 'meta.type.annotation entity.name.type'],
      settings: { foreground: v('type') }
    },
    { scope: ['variable.other.property', 'variable.other.object.property', 'support.type.property-name', 'entity.other.attribute-name', 'meta.object-literal.key'], settings: { foreground: v('property') } },
    { scope: ['variable', 'variable.parameter', 'meta.definition.variable'], settings: { foreground: v('variable') } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: v('punct') } },
    { scope: ['markup.heading', 'markup.bold'], settings: { foreground: 'var(--vy-fg-strong)', fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.inserted'], settings: { foreground: 'var(--vy-success)' } },
    { scope: ['markup.deleted'], settings: { foreground: 'var(--vy-danger)' } }
  ]
}

const LANGS = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs')
} as const
type Lang = keyof typeof LANGS

const ALIASES: Record<string, Lang> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  'c++': 'cpp',
  cs: 'csharp',
  docker: 'dockerfile',
  golang: 'go',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  yml: 'yaml'
}

export function resolveLang(lang: string): Lang | null {
  const l = lang.trim().toLowerCase()
  if (!l) return null
  return l in LANGS ? (l as Lang) : (ALIASES[l] ?? null)
}

/** The grammar for a path, from its extension. */
export function langFromPath(path: string): Lang | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  if (/^dockerfile$/i.test(name)) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? resolveLang(name.slice(dot + 1)) : null
}

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<Lang>()

async function ready(lang: Lang): Promise<HighlighterCore | null> {
  try {
    core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([shiki, engine]) =>
      shiki.createHighlighterCore({ themes: [THEME], langs: [], engine: engine.createJavaScriptRegexEngine({ forgiving: true }) })
    )
    const hl = await core
    if (!loaded.has(lang)) {
      await hl.loadLanguage(await LANGS[lang]())
      loaded.add(lang)
    }
    return hl
  } catch {
    core = null
    return null
  }
}

export type Token = { text: string; color?: string; italic?: boolean }
type Lines = Token[][]

function tokenize(hl: HighlighterCore, text: string, lang: Lang, state?: GrammarState): { lines: Lines; state?: GrammarState } {
  const tokens = hl.codeToTokensBase(text, { lang, theme: 'vy', grammarState: state })
  return {
    lines: tokens.map((line) => line.map((t) => ({ text: t.content, color: t.color, italic: ((t.fontStyle ?? 0) & 1) === 1 }))),
    state: hl.getLastGrammarState(tokens)
  }
}

/** Finished blocks, by language and text. Bounded: a long session cannot grow it without limit. */
const done = new Map<string, Lines>()
const DONE_MAX = 200
function remember(key: string, lines: Lines): void {
  done.delete(key)
  done.set(key, lines)
  if (done.size > DONE_MAX) done.delete(done.keys().next().value as string)
}

/**
 * Colour `text` as `lang`. Returns one token list per line that is coloured
 * so far — while streaming that is every finished line, and the caller shows
 * the line still being written as plain text.
 */
export function useHighlight(text: string, lang: string, streaming: boolean): Lines | null {
  const grammar = resolveLang(lang)
  // While streaming, only lines that have ended are stable enough to colour. A fence's
  // text always ends in "\n", so the line being written is the one before that.
  const cut = streaming ? text.replace(/\n$/, '').lastIndexOf('\n') : text.length
  const stable = cut > 0 ? text.slice(0, cut) : ''
  const key = `${grammar}\0${stable}`
  const [lines, setLines] = useState<Lines | null>(() => (grammar && !streaming ? (done.get(key) ?? null) : null))
  const run = useRef<{ lang: Lang; text: string; lines: Lines; state?: GrammarState } | null>(null)

  useEffect(() => {
    if (!grammar || !stable) {
      setLines(null)
      return
    }
    const hit = done.get(key)
    if (hit) {
      setLines(hit)
      return
    }
    let gone = false
    void ready(grammar).then((hl) => {
      if (gone || !hl) return
      try {
        const prev = run.current
        let next: { lines: Lines; state?: GrammarState }
        if (prev && prev.lang === grammar && stable.startsWith(`${prev.text}\n`)) {
          // Continue from where the last finished line left the grammar.
          const more = tokenize(hl, stable.slice(prev.text.length + 1), grammar, prev.state)
          next = { lines: [...prev.lines, ...more.lines], state: more.state }
        } else {
          next = tokenize(hl, stable, grammar)
        }
        run.current = { lang: grammar, text: stable, ...next }
        if (!streaming) remember(key, next.lines)
        setLines(next.lines)
      } catch {
        setLines(null)
      }
    })
    return () => {
      gone = true
    }
  }, [key, grammar, stable, streaming])

  return grammar ? lines : null
}
