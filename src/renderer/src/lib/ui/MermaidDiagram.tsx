import { memo, useEffect, useState } from 'react'
import { useDocumentTheme } from './useDocumentTheme'
import { CodeBlockCopyButton } from './CodeBlockCopyButton'

type MermaidApi = (typeof import('mermaid'))['default']

/**
 * Lazy loader: one dynamic `import('mermaid')`, so the multi-megabyte mermaid
 * chunk is fetched only when a diagram renders and never enters the main
 * bundle (performance rules: renderer-only, code-split).
 */
let mermaidPromise: Promise<MermaidApi> | null = null
/** The theme variables mermaid was last initialised with (JSON). */
let initialisedWith: string | null = null

/** Each role's token ladder: first name first, then those that mean the same. */
const BG = ['--vy-sunken', '--vy-bg', '--vy-card'] as const
const SURFACE = ['--vy-surface', '--vy-surface-2', '--vy-card'] as const
const CARD = ['--vy-card', '--vy-surface'] as const
const BORDER = ['--vy-border', '--vy-border-strong'] as const
const BORDER_STRONG = ['--vy-border-strong', '--vy-border'] as const
const FG = ['--vy-fg', '--vy-fg-strong'] as const
const FG_STRONG = ['--vy-fg-strong', '--vy-fg'] as const
const MUTED = ['--vy-muted', '--vy-tertiary', '--vy-fg'] as const

/**
 * The first token on the ladder whose computed value mermaid can parse, or ''
 * when none of them can. Mermaid's theme object cannot take `var()` and parses
 * colours itself, so a value that is not a plain hex/rgb/hsl colour (a custom
 * skin's `color-mix`, say) is skipped for the next name on the ladder — every
 * skin/theme block in `styles.css` defines these tokens as literals, so the
 * first name resolves in the app. Nothing here invents a colour: a role no
 * token filled is dropped from the theme, leaving mermaid its own base value.
 * (TerminalPanel's readCssColor is the sanctioned *literal* shape; this is the
 * same read with the literals gone.)
 */
function readCssColor(varNames: readonly string[]): string {
  if (typeof document === 'undefined') return ''
  const computed = getComputedStyle(document.documentElement)
  for (const varName of varNames) {
    const value = computed.getPropertyValue(varName).trim()
    if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(value)) return value
  }
  return ''
}

/** Diagrams drawn from the active skin's tokens, so all five skins reach them. */
export function readMermaidThemeVariables(dark: boolean): Record<string, string | boolean> {
  const bg = readCssColor(BG)
  const surface = readCssColor(SURFACE)
  const card = readCssColor(CARD)
  const border = readCssColor(BORDER)
  const borderStrong = readCssColor(BORDER_STRONG)
  const fg = readCssColor(FG)
  const fgStrong = readCssColor(FG_STRONG)
  const muted = readCssColor(MUTED)
  const theme: Record<string, string | boolean> = {
    darkMode: dark,
    background: bg,
    fontFamily: 'inherit',
    primaryColor: surface,
    primaryTextColor: fgStrong,
    primaryBorderColor: borderStrong,
    secondaryColor: card,
    secondaryTextColor: fg,
    secondaryBorderColor: border,
    tertiaryColor: bg,
    tertiaryTextColor: fg,
    tertiaryBorderColor: border,
    mainBkg: surface,
    nodeBorder: borderStrong,
    clusterBkg: card,
    clusterBorder: border,
    lineColor: muted,
    textColor: fg,
    titleColor: fgStrong,
    edgeLabelBackground: bg,
    noteBkgColor: card,
    noteTextColor: fg,
    noteBorderColor: border
  }
  for (const [key, value] of Object.entries(theme)) {
    if (value === '') delete theme[key]
  }
  return theme
}

function loadMermaid(themeVariables: Record<string, string | boolean>): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((mod) => mod.default)
  const key = JSON.stringify(themeVariables)
  return mermaidPromise.then((mermaid) => {
    if (initialisedWith !== key) {
      initialisedWith = key
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // Suppress mermaid's own error-diagram SVG ("Syntax error in text");
        // on failure mermaid removes its temp `d${id}` element before rejecting.
        suppressErrorRendering: true,
        theme: 'base',
        themeVariables,
        // Mermaid 12 defaults to a new look (glow shadows, orthogonal edges)
        // and re-lays out flowcharts; these keep diagrams as they were drawn.
        look: 'classic',
        layout: 'dagre'
      })
    }
    return mermaid
  })
}

/** The active skin, tracked from the root element (tokens change with it). */
function useDocumentSkin(): string {
  const [skin, setSkin] = useState(() =>
    typeof document !== 'undefined' ? (document.documentElement.dataset.skin ?? '') : ''
  )
  useEffect(() => {
    const root = document.documentElement
    const sync = (): void => setSkin(root.dataset.skin ?? '')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-skin'] })
    return () => observer.disconnect()
  }, [])
  return skin
}

let renderSeq = 0

/**
 * Renders a ```mermaid fence as a real SVG diagram. Invalid syntax falls back
 * to the plain code block; the caller never passes an unstable (streaming)
 * fence, so diagrams only appear for settled content.
 */
export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const theme = useDocumentTheme()
  const skin = useDocumentSkin()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)
    // Unique id per render attempt — mermaid requires document-unique ids.
    const id = `vy-mermaid-${renderSeq++}`
    // Read at render time: the tokens are whatever the theme and skin are now.
    void loadMermaid(readMermaidThemeVariables(theme === 'dark'))
      .then((mermaid) => mermaid.render(id, code))
      .then((result) => {
        if (!cancelled) setSvg(result.svg)
      })
      .catch(() => {
        // Defense in depth: mermaid's render() draws into a temp element it
        // appends to document.body (div id `d${id}`, iframe id `i${id}` in
        // sandbox mode). If it ever rejects without removing them (older
        // paths, draw failures), strip the strays so no error SVG leaks.
        document.getElementById(`d${id}`)?.remove()
        document.getElementById(`i${id}`)?.remove()
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [code, theme, skin])

  return (
    <div
      className="group/code relative my-2"
      data-mermaid-diagram={svg ? '' : undefined}
      data-mermaid-failed={failed ? '' : undefined}
    >
      <CodeBlockCopyButton text={code} />
      {/* The code-block shell; the inset lives on the content, never on both. */}
      <div className="overflow-x-auto rounded-md border border-border bg-sunken">
        {svg ? (
          <div
            className="p-3 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <pre className="m-0 overflow-x-auto bg-transparent p-3 font-mono text-xs">
            <code className="block language-mermaid">{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
})
