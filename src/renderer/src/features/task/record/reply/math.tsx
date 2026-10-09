import { useEffect, useState } from 'react'

/*
  Math in a reply. remark-math parses `$$…$$` (inline, or a block on its own
  lines) and ```math fences; a single `$` is left alone, because an agent's
  prose is full of prices and shell variables ("$5 and $10", "$HOME").
  Models that write `\(…\)` and `\[…\]` get them turned into the same.

  KaTeX is loaded the first time a reply has math, so it never weighs on a
  window that shows none. Until it arrives, and if it fails, the TeX shows as
  code: never a blank.
*/

type Katex = (typeof import('katex'))['default']
let katexPromise: Promise<Katex> | null = null

function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => mod.default)
  return katexPromise
}

/** TeX as HTML: never trusted with links or commands that reach outside the formula. */
function renderTex(katex: Katex, tex: string, display: boolean): string {
  return katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    output: 'htmlAndMathml',
    trust: false,
    strict: 'ignore',
    maxSize: 50,
    maxExpand: 500
  })
}

export function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void loadKatex()
      .then((katex) => {
        if (live) setHtml(renderTex(katex, tex, display))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [tex, display])
  if (html === null) {
    return display ? (
      <pre className="vy-reply-math-display" data-math="display">
        <code>{tex}</code>
      </pre>
    ) : (
      <code data-math="inline">{tex}</code>
    )
  }
  return display ? (
    <div className="vy-reply-math-display overflow-x-auto" data-math="display" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="vy-reply-math" data-math="inline" dangerouslySetInnerHTML={{ __html: html }} />
  )
}

/** True for remark-math's `code.language-math` (inline math once the fence is gone). */
export function isMathClassName(className: string | undefined): boolean {
  return Boolean(className?.split(/\s+/).includes('language-math'))
}

const FENCE = /^\s*(```|~~~)/
const DISPLAY_OPEN = /^\s*\\\[\s*$/
const DISPLAY_CLOSE = /^\s*\\\]\s*$/
const DISPLAY_ONE_LINE = /^\s*\\\[(.+)\\\]\s*$/

/**
 * `\(…\)` → `$$…$$` and `\[…\]` → a `$$` block, outside fences and inline
 * code, so the delimiters other models write render like remark-math's own.
 */
export function normalizeMathDelimiters(md: string): string {
  if (!md.includes('\\(') && !md.includes('\\[')) return md
  let fenced = false
  return md
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      if (DISPLAY_OPEN.test(line) || DISPLAY_CLOSE.test(line)) return '$$'
      const one = DISPLAY_ONE_LINE.exec(line)
      if (one) return `$$\n${one[1]!.trim()}\n$$`
      // Odd pieces are inline code spans: left as written.
      return line
        .split(/(`+[^`]*`+)/)
        .map((piece, i) => (i % 2 === 1 ? piece : piece.replace(/\\\((.+?)\\\)/g, (_, tex: string) => `$$${tex}$$`)))
        .join('')
    })
    .join('\n')
}
