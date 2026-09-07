import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { CodeBlockCopyButton } from './CodeBlockCopyButton'
import { MermaidDiagram } from './MermaidDiagram'
import { highlightCode } from '@renderer/lib/markdown/markdownHighlight'
import {
  balanceOutsideFences,
  closeOpenFence,
  isFenceCloser,
  parseFenceLine,
  trailingOpenFenceBody
} from '@renderer/lib/markdown/fenceUtils'
import {
  allocateHeadingId,
  extractHeadingText
} from '@renderer/lib/markdown/headingIds'
import {
  isSafeMarkdownHref,
  markdownSanitizeSchema,
  sanitizeHighlightedHtml
} from '@renderer/lib/markdown/markdownSanitize'
import {
  autolinkWorkspacePathsInProse,
  parseLinkableWorkspacePath,
  parseVyFileHref
} from '@shared/utils/linkableWorkspacePath'
import { cn } from './cn'
import { useDocumentTheme } from './useDocumentTheme'

export { trailingOpenFenceBody } from '@renderer/lib/markdown/fenceUtils'

/** Balance unclosed fences and inline markdown when a stream completes. */
export function balanceIncompleteMarkdown(content: string): string {
  return balanceOutsideFences(closeOpenFence(content))
}

/** Alias used by streaming markdown paths. */
export function prepareStreamingMarkdown(content: string): string {
  return balanceIncompleteMarkdown(content)
}

type MarkdownBlock = { source: string; start: number }

/**
 * Split markdown into stable block units (paragraphs / fences / headings).
 * Finished blocks keep stable identity so React.memo can skip them while the
 * last block streams. Fence boundaries use the same CommonMark rules as
 * {@link closeOpenFence} (variable length, indented openers).
 */
export function splitMarkdownBlocks(source: string): MarkdownBlock[] {
  if (!source) return []
  const lines = source.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const start = i
    const parsed = parseFenceLine(lines[i]!)
    if (parsed) {
      const open = parsed.open
      let j = i + 1
      while (j < lines.length && !isFenceCloser(lines[j]!, open)) j++
      if (j >= lines.length) {
        blocks.push({ start, source: lines.slice(i).join('\n') })
        break
      }
      // Include closer; keep a trailing newline when more content follows so the
      // next block's start index stays stable across streaming ticks.
      const end = j + 1
      const chunk = lines.slice(i, end).join('\n')
      blocks.push({ start, source: end < lines.length ? `${chunk}\n` : chunk })
      i = end
      continue
    }

    // Paragraph / prose: consume through the next blank line (inclusive) or up
    // to the next fence opener.
    let j = i + 1
    while (j < lines.length) {
      if (lines[j] === '') {
        j++
        break
      }
      if (parseFenceLine(lines[j]!)) break
      j++
    }
    blocks.push({ start, source: lines.slice(i, j).join('\n') })
    i = j
  }
  return blocks.filter((b) => b.source.length > 0)
}

/** Max highlighted fence entries retained across the renderer session. */
export const HIGHLIGHT_CACHE_MAX_ENTRIES = 200

const highlightCache = new Map<string, string>()

const remarkPlugins = [remarkGfm]
const rehypePlugins: import('react-markdown').Options['rehypePlugins'] = [
  [rehypeSanitize, markdownSanitizeSchema]
]

function highlightCacheKey(text: string, lang: string, theme: string): string {
  return `${theme}\0${lang}\0${text}`
}

/** FIFO-bounded set; exported helpers used by FencedCodeBlock and tests. */
export function setHighlightCacheEntry(key: string, html: string): void {
  if (highlightCache.has(key)) {
    highlightCache.delete(key)
  }
  highlightCache.set(key, html)
  while (highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
}

export function getHighlightCacheEntry(key: string): string | undefined {
  return highlightCache.get(key)
}

/** @internal Reset cache between tests. */
export function clearHighlightCacheForTests(): void {
  highlightCache.clear()
}

/** @internal */
export function highlightCacheSizeForTests(): number {
  return highlightCache.size
}

function scheduleIdle(cb: () => void, timeoutMs: number): () => void {
  const w = typeof window !== 'undefined' ? window : null
  if (w && typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(() => cb(), { timeout: timeoutMs })
    return () => w.cancelIdleCallback(id)
  }
  const id = globalThis.setTimeout(cb, Math.min(timeoutMs, 80))
  return () => globalThis.clearTimeout(id)
}

const CODE_SHELL =
  'overflow-x-auto rounded-md border border-border bg-surface font-mono text-[0.85em]'

function FencedCodeBlock({
  text,
  className,
  unstable = false
}: {
  text: string
  className?: string
  /** Still being streamed, so highlighting it would be re-thrown away next delta. */
  unstable?: boolean
}) {
  const lang = className?.replace(/^language-/, '') ?? ''
  const theme = useDocumentTheme()
  const cacheKey = highlightCacheKey(text, lang, theme)
  const [html, setHtml] = useState<string | null>(() =>
    unstable ? null : (getHighlightCacheEntry(cacheKey) ?? null)
  )

  useEffect(() => {
    if (unstable) {
      // Drop stale highlight while the fence is still growing; plain shell stays.
      setHtml(null)
      return
    }
    const cached = getHighlightCacheEntry(cacheKey)
    if (cached) {
      setHtml(cached)
      return
    }
    // Invalidate any prior highlight so plain text matches `text` until ready.
    // Unified shell keeps the bordered container — this is not an empty flash.
    setHtml(null)
    let cancelled = false
    const cancelIdle = scheduleIdle(() => {
      void highlightCode(text, lang).then((result) => {
        if (cancelled) return
        const next = result ? sanitizeHighlightedHtml(result) : null
        if (next) setHighlightCacheEntry(cacheKey, next)
        setHtml(next)
      })
    }, 80)
    return () => {
      cancelled = true
      cancelIdle()
    }
  }, [text, lang, unstable, theme, cacheKey])

  return (
    <div className="group/code relative my-2">
      <CodeBlockCopyButton text={text} />
      <div className={CODE_SHELL}>
        {html ? (
          <div
            className="vy-transition [&>pre]:m-0 [&>pre]:overflow-x-auto [&>pre]:bg-transparent [&>pre]:p-3"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="m-0 overflow-x-auto bg-transparent p-3">
            <code className={cn('block', className)}>{text}</code>
          </pre>
        )}
      </div>
    </div>
  )
}

function FencedCodePre({
  children,
  openFenceBody
}: {
  children?: ReactNode
  openFenceBody: string | null
}) {
  const child = Children.toArray(children).find(isValidElement) as
    | ReactElement<{ className?: string; children?: ReactNode }>
    | undefined
  if (!child) {
    return (
      <pre className="my-2 overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-[0.85em]">
        {children}
      </pre>
    )
  }

  const className = child.props.className ?? ''
  const normalize = (s: string) => s.replace(/\n+$/, '')
  const text = normalize(String(child.props.children ?? ''))
  const unstable = openFenceBody !== null && text === normalize(openFenceBody)
  // Mermaid fences render as real diagrams once settled; branch here (hook-free)
  // rather than inside FencedCodeBlock to preserve hook order.
  if (className.includes('language-mermaid') && !unstable) {
    return <MermaidDiagram code={text} />
  }
  return <FencedCodeBlock text={text} className={className} unstable={unstable} />
}

function buildHeadingComponents(used: Map<string, number>) {
  const make =
    (Tag: 'h1' | 'h2' | 'h3') =>
    ({ children }: { children?: React.ReactNode }) => {
      const text = extractHeadingText(children)
      const id = allocateHeadingId(text, used)
      return <Tag id={id}>{children}</Tag>
    }
  return { h1: make('h1'), h2: make('h2'), h3: make('h3') }
}

const CODE_CHIP =
  'rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.85em] hover:bg-surface-2 focus-visible:bg-surface-2'

function formatLinkablePathText(parsed: { path: string; line?: number }): string {
  return parsed.line != null ? `${parsed.path}:${parsed.line}` : parsed.path
}

function buildMarkdownComponents(
  openFenceBody: string | null,
  opts?: {
    headingIds?: boolean
    headingUsed?: Map<string, number>
    readOnlyTasks?: boolean
    onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
  }
) {
  const heading =
    opts?.headingIds && opts.headingUsed ? buildHeadingComponents(opts.headingUsed) : null
  const onOpenWorkspaceFile = opts?.onOpenWorkspaceFile
  return {
    ...(heading ?? {}),
    ...(opts?.readOnlyTasks
      ? {
          input: (props: InputHTMLAttributes<HTMLInputElement> & { node?: unknown }) => {
            if (props.type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  checked={Boolean(props.checked)}
                  disabled
                  readOnly
                  tabIndex={-1}
                />
              )
            }
            const { node: _node, ...rest } = props
            return <input {...rest} />
          }
        }
      : {}),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const fileTarget = parseVyFileHref(href)
      if (fileTarget && onOpenWorkspaceFile) {
        return (
          <button
            type="button"
            className={CODE_CHIP}
            onClick={() =>
              onOpenWorkspaceFile(
                fileTarget.path,
                fileTarget.line ? { line: fileTarget.line } : undefined
              )
            }
          >
            {children}
          </button>
        )
      }
      if (!isSafeMarkdownHref(href)) {
        // Keep the author's visible text without exposing an inert link target.
        return <span className="text-muted underline">{children}</span>
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-muted underline">
          {children}
        </a>
      )
    },
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="markdown-table-scroll my-2 max-w-full overflow-x-auto" data-markdown-table-scroll>
        <table>{children}</table>
      </div>
    ),
    code: ({
      className: codeClass,
      children
    }: {
      className?: string
      children?: React.ReactNode
    }) => {
      if (codeClass?.includes('language-')) {
        return <code className={cn('block font-mono text-[0.85em]', codeClass)}>{children}</code>
      }
      const text = String(children ?? '').trim()
      const parsed = parseLinkableWorkspacePath(text)
      if (parsed && onOpenWorkspaceFile && text === formatLinkablePathText(parsed)) {
        return (
          <button
            type="button"
            className={CODE_CHIP}
            onClick={() =>
              onOpenWorkspaceFile(
                parsed.path,
                parsed.line ? { line: parsed.line } : undefined
              )
            }
          >
            {children}
          </button>
        )
      }
      return (
        <code className={cn('rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.85em]', codeClass)}>
          {children}
        </code>
      )
    },
    pre: ({ children }: { children?: React.ReactNode }) => (
      <FencedCodePre openFenceBody={openFenceBody}>{children}</FencedCodePre>
    )
  }
}

const MemoMarkdownBlock = memo(function MemoMarkdownBlock({
  source,
  openFenceBody,
  headingIds,
  headingUsed,
  readOnlyTasks,
  linkWorkspacePaths,
  onOpenWorkspaceFile
}: {
  source: string
  openFenceBody: string | null
  headingIds?: boolean
  headingUsed?: Map<string, number>
  readOnlyTasks?: boolean
  linkWorkspacePaths?: boolean
  onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
}) {
  const renderedSource = useMemo(() => {
    if (!linkWorkspacePaths || parseFenceLine(source.split('\n')[0] ?? '')) return source
    return autolinkWorkspacePathsInProse(source)
  }, [linkWorkspacePaths, source])
  const components = useMemo(
    () =>
      buildMarkdownComponents(openFenceBody, {
        headingIds,
        headingUsed,
        readOnlyTasks,
        onOpenWorkspaceFile
      }),
    [openFenceBody, headingIds, headingUsed, readOnlyTasks, onOpenWorkspaceFile]
  )
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {renderedSource}
    </Markdown>
  )
})

export function MarkdownContent({
  content,
  streaming = false,
  headingIds = false,
  wrapTables = false,
  readOnlyTasks = false,
  linkWorkspacePaths = false,
  onOpenWorkspaceFile,
  className
}: {
  content: string
  streaming?: boolean
  /** Stable h1–h3 ids for in-panel outline scroll (plan docs). */
  headingIds?: boolean
  /** Allow table cells to wrap (narrow plan/contract dock). */
  wrapTables?: boolean
  /** Disable GFM task checkboxes (display-only). */
  readOnlyTasks?: boolean
  /** Auto-link bare workspace-relative paths in prose (assistant chat). */
  linkWorkspacePaths?: boolean
  onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
  className?: string
}) {
  const markdown = useMemo(
    () => (streaming ? prepareStreamingMarkdown(content) : balanceIncompleteMarkdown(content)),
    [streaming, content]
  )
  const openFenceBody = useMemo(
    () => (streaming ? trailingOpenFenceBody(content) : null),
    [streaming, content]
  )
  // Stable across unrelated re-renders (only reset when the rendered markdown
  // changes) so MemoMarkdownBlock's `components` memo is not defeated every tick.
  // `markdown` is an intentional reset key: a fresh Map per content change keeps
  // heading-id counters deterministic across edits.
  const headingUsed = useMemo(
    () => (headingIds ? new Map<string, number>() : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headingIds, markdown]
  )
  // Callers often pass an inline `onOpenWorkspaceFile`, whose identity changes
  // every render and would defeat the block memo. Route through a stable closure
  // backed by a ref so the memoized `components` stay stable unless content changes.
  const onOpenRef = useRef(onOpenWorkspaceFile)
  onOpenRef.current = onOpenWorkspaceFile
  const openWorkspaceFileStable = useCallback(
    (path: string, options?: { line?: number }) => onOpenRef.current?.(path, options),
    []
  )
  const blocks = useMemo(() => splitMarkdownBlocks(markdown), [markdown])
  const hasVisibleContent = content.trim().length > 0

  if (!hasVisibleContent) return null

  return (
    <div
      className={cn(
        'markdown-body text-sm leading-relaxed text-fg [overflow-wrap:anywhere] [&_pre]:[overflow-wrap:normal]',
        // Chat transcript: keep table cells from exploding layout. Plan panel opts into wrap.
        !wrapTables &&
          '[&_table]:[overflow-wrap:normal] [&_th]:[overflow-wrap:normal] [&_td]:[overflow-wrap:normal]',
        wrapTables &&
          '[&_table]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere] [&_td]:[overflow-wrap:anywhere]',
        headingIds && 'markdown-body--heading-ids',
        className
      )}
    >
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1
        const blockOpenFence = streaming && isLast ? openFenceBody : null
        // Stable keys so streaming deltas update `source` instead of remounting.
        const key = `md-block-${block.start}`
        return (
          <MemoMarkdownBlock
            key={key}
            source={block.source}
            openFenceBody={blockOpenFence}
            headingIds={headingIds}
            headingUsed={headingUsed}
            readOnlyTasks={readOnlyTasks}
            linkWorkspacePaths={linkWorkspacePaths}
            onOpenWorkspaceFile={linkWorkspacePaths ? openWorkspaceFileStable : undefined}
          />
        )
      })}
    </div>
  )
}
