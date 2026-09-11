import type { HighlighterCore } from 'shiki/core'

// Importing the `shiki` root entry registers every bundled grammar, which emits ~250
// chunks into the renderer build. Load the core plus the languages we actually render.
const LANGUAGE_LOADERS = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs')
} as const

type SupportedLanguage = keyof typeof LANGUAGE_LOADERS

const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  md: 'markdown',
  py: 'python',
  yml: 'yaml'
}

let corePromise: Promise<HighlighterCore> | null = null
const loadedLanguages = new Set<SupportedLanguage>()

async function createCore(): Promise<HighlighterCore> {
  const [shiki, engine] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript')
  ])
  return shiki.createHighlighterCore({
    themes: [import('shiki/themes/github-dark.mjs'), import('shiki/themes/github-light.mjs')],
    langs: [],
    engine: engine.createJavaScriptRegexEngine()
  })
}

function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = createCore().catch((err) => {
      corePromise = null
      throw err
    })
  }
  return corePromise
}

function resolveLanguage(lang: string): SupportedLanguage | null {
  const normalized = lang.trim().toLowerCase()
  if (!normalized) return null
  if (normalized in LANGUAGE_LOADERS) return normalized as SupportedLanguage
  return LANGUAGE_ALIASES[normalized] ?? null
}

/** The grammar to use for a file, or null when we have none for that extension. */
export function languageFromPath(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return resolveLanguage(name.slice(dot + 1))
}

function resolveTheme(): 'github-dark' | 'github-light' {
  if (typeof document === 'undefined') return 'github-light'
  return document.documentElement.dataset.theme === 'dark' ? 'github-dark' : 'github-light'
}

async function prepare(lang: string): Promise<{ core: HighlighterCore; language: string } | null> {
  const language = resolveLanguage(lang)
  if (!language) return null
  try {
    const core = await getCore()
    if (!loadedLanguages.has(language)) {
      await core.loadLanguage(await LANGUAGE_LOADERS[language]())
      loadedLanguages.add(language)
    }
    return { core, language }
  } catch {
    return null
  }
}

/** Returns highlighted HTML, or null when the language is unsupported or loading fails. */
export async function highlightCode(text: string, lang: string): Promise<string | null> {
  const ready = await prepare(lang)
  if (!ready) return null
  try {
    return ready.core.codeToHtml(text, { lang: ready.language, theme: resolveTheme() })
  } catch {
    return null
  }
}

export type CodeToken = { text: string; color?: string }

/**
 * Highlight to one token list per line rather than to HTML.
 *
 * A diff needs to own its own row markup — gutter, sign column, per-row tint —
 * so it cannot use the `<pre>` that `highlightCode` produces, but it still wants
 * the same colours. One entry per line of `text`, or null if we cannot help.
 */
export async function highlightToLines(text: string, lang: string): Promise<CodeToken[][] | null> {
  const ready = await prepare(lang)
  if (!ready) return null
  try {
    const { tokens } = ready.core.codeToTokens(text, {
      lang: ready.language,
      theme: resolveTheme()
    })
    return tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color })))
  } catch {
    return null
  }
}
