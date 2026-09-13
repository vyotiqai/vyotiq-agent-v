import { memo, useEffect, useState } from 'react'
import { useDocumentTheme } from './useDocumentTheme'
import { CodeBlockCopyButton } from './CodeBlockCopyButton'

type MermaidApi = (typeof import('mermaid'))['default']

/**
 * Theme-keyed lazy loader: one dynamic `import('mermaid')` per theme flip, so
 * the multi-megabyte mermaid chunk is fetched only when a diagram renders and
 * never enters the main bundle (performance rules: renderer-only, code-split).
 */
let loadedTheme: 'dark' | 'neutral' | null = null
let mermaidPromise: Promise<MermaidApi> | null = null

function loadMermaid(theme: 'dark' | 'neutral'): Promise<MermaidApi> {
  if (!mermaidPromise || loadedTheme !== theme) {
    loadedTheme = theme
    mermaidPromise = import('mermaid').then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // Suppress mermaid's own error-diagram SVG ("Syntax error in text");
        // on failure mermaid removes its temp `d${id}` element before rejecting.
        suppressErrorRendering: true,
        theme
      })
      return mod.default
    })
  }
  return mermaidPromise
}

let renderSeq = 0

/**
 * Renders a ```mermaid fence as a real SVG diagram. Invalid syntax falls back
 * to the plain code block; the caller never passes an unstable (streaming)
 * fence, so diagrams only appear for settled content.
 */
export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const theme = useDocumentTheme()
  const mermaidTheme = theme === 'dark' ? 'dark' : 'neutral'
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)
    // Unique id per render attempt — mermaid requires document-unique ids.
    const id = `vy-mermaid-${renderSeq++}`
    void loadMermaid(mermaidTheme)
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
  }, [code, mermaidTheme])

  return (
    <div
      className="group/code relative my-2"
      data-mermaid-diagram={svg ? '' : undefined}
      data-mermaid-failed={failed ? '' : undefined}
    >
      <CodeBlockCopyButton text={code} />
      <div className="overflow-x-auto rounded-md border border-border bg-surface p-3">
        {svg ? (
          <div
            className="[&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <pre className="m-0 overflow-x-auto bg-transparent p-3 font-mono text-[0.85em]">
            <code className="block language-mermaid">{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
})
