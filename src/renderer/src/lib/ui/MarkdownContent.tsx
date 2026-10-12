import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
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
import { ChartBlock } from './ChartBlock'
import { parseChartSpec } from '@shared/chartSpec'
import { highlightCode } from '@renderer/lib/markdown/markdownHighlight'
import {
  balanceOutsideFences,
  closeOpenFence,
  isFenceCloser,
  mapOutsideFences,
  parseFenceLine,
  trailingOpenFenceBody
} from '@renderer/lib/markdown/fenceUtils'
import {
  isSafeMarkdownHref,
  markdownSanitizeSchema,
  sanitizeHighlightedHtml
} from '@renderer/lib/markdown/markdownSanitize'
import { formatCitationsInProse } from '@shared/utils/linkableWorkspacePath'
import { cn } from './cn'
import { useDocumentTheme } from './useDocumentTheme'

/** Balance unclosed fences and inline markdown when a stream completes. */
export function balanceIncompleteMarkdown(content: string): string {
  return balanceOutsideFences(closeOpenFence(content))
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
  'overflow-x-auto rounded-md border border-border bg-sunken font-mono text-xs'

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
      <pre className="my-2 overflow-x-auto rounded-md border border-border bg-sunken p-3 font-mono text-xs">
        {children}
      </pre>
    )
  }

  const className = child.props.className ?? ''
  const normalize = (s: string) => s.replace(/\n+$/, '')
  const text = normalize(String(child.props.children ?? ''))
  const unstable = openFenceBody !== null && text === normalize(openFenceBody)
  // Mermaid and chart fences render as real visuals once settled; branch here
  // (hook-free) rather than inside FencedCodeBlock to preserve hook order.
  // A chart fence whose body fails the schema falls back to the code block.
  if (className.includes('language-mermaid') && !unstable) {
    return <MermaidDiagram code={text} />
  }
  if (className.includes('language-chart') && !unstable) {
    const spec = parseChartSpec(text)
    if (spec) {
      return <ChartBlock spec={spec} />
    }
  }
  return <FencedCodeBlock text={text} className={className} unstable={unstable} />
}

/**
 * Inline code, with no filled rectangle behind it. The mono face, the step-down
 * ink the markdown stylesheet gives it, and a hairline under the text are what
 * say "code" — a `bg-surface` box made a paragraph naming a dozen files read as a
 * row of grey tiles. `BORDER_DIVIDER` is the named quiet-grey weight, so nothing
 * here invents a colour (CLAUDE.md: never hardcode one, never reach for a new
 * opacity).
 */
const CODE_BASE = 'rounded-sm border-b border-border/60 px-1 py-0.5 font-mono text-[0.85em]'

function buildMarkdownComponents(openFenceBody: string | null, readOnlyTasks: boolean) {
  return {
    ...(readOnlyTasks
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
      if (!isSafeMarkdownHref(href)) {
        // Keep the author's visible text without exposing an inert link target.
        return <span className="text-muted underline">{children}</span>
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-sm text-muted underline focus-visible:vy-focus-ring"
        >
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
        // Sized by the code shell it lands in (`text-xs`), not shrunk again.
        return <code className={cn('block font-mono', codeClass)}>{children}</code>
      }
      return <code className={cn(CODE_BASE, codeClass)}>{children}</code>
    },
    pre: ({ children }: { children?: React.ReactNode }) => (
      <FencedCodePre openFenceBody={openFenceBody}>{children}</FencedCodePre>
    )
  }
}

const MemoMarkdownBlock = memo(function MemoMarkdownBlock({
  source,
  openFenceBody,
  readOnlyTasks
}: {
  source: string
  openFenceBody: string | null
  readOnlyTasks: boolean
}) {
  // `[[path:line]]` citations read as code; a fence's lines are code already.
  const renderedSource = useMemo(() => mapOutsideFences(source, formatCitationsInProse), [source])
  const components = useMemo(
    () => buildMarkdownComponents(openFenceBody, readOnlyTasks),
    [openFenceBody, readOnlyTasks]
  )
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {renderedSource}
    </Markdown>
  )
})

/** Every size reads on the scale's relaxed line. */
const MARKDOWN_SIZE = {
  caption: 'text-caption leading-relaxed',
  sm: 'text-sm leading-relaxed'
} as const

const MARKDOWN_TONE = {
  default: 'text-fg',
  secondary: 'text-secondary'
} as const

/**
 * Markdown that is not the agent's reply — a plan or contract, a PR or review
 * body, a workspace `.md` file, a skill or fetched page in a tool body. The
 * agent's own words in the record render through `features/task/record/reply`.
 */
export function MarkdownContent({
  content,
  streaming = false,
  wrapTables = false,
  readOnlyTasks = false,
  size = 'sm',
  tone = 'default',
  className
}: {
  content: string
  streaming?: boolean
  /** Allow table cells to wrap (narrow plan/contract dock). */
  wrapTables?: boolean
  /** Disable GFM task checkboxes (display-only). */
  readOnlyTasks?: boolean
  /**
   * Body text size. The root owns size, leading and colour, so a class on a
   * wrapper (or in `className`) never reaches the text — pass these instead.
   * `caption` is prose inside a tool body.
   */
  size?: 'caption' | 'sm'
  /** Body text colour. `secondary` is prose under its own headings (the Plan tab). */
  tone?: 'default' | 'secondary'
  className?: string
}) {
  const markdown = useMemo(() => balanceIncompleteMarkdown(content), [content])
  const openFenceBody = useMemo(
    () => (streaming ? trailingOpenFenceBody(content) : null),
    [streaming, content]
  )
  // Streaming re-renders only the block still growing. A finished document is
  // one block: splitting it at blank lines cut footnotes from their notes and
  // loose lists into one list per item.
  const blocks = useMemo(
    () => (streaming ? splitMarkdownBlocks(markdown) : [{ source: markdown, start: 0 }]),
    [streaming, markdown]
  )
  const hasVisibleContent = content.trim().length > 0

  if (!hasVisibleContent) return null

  return (
    <div
      className={cn(
        'markdown-body [overflow-wrap:anywhere] [&_pre]:[overflow-wrap:normal]',
        // One size and one colour class each, so nothing depends on sheet order.
        MARKDOWN_SIZE[size],
        MARKDOWN_TONE[tone],
        // Keep table cells from exploding layout. The Plan panel opts into wrap.
        !wrapTables &&
          '[&_table]:[overflow-wrap:normal] [&_th]:[overflow-wrap:normal] [&_td]:[overflow-wrap:normal]',
        wrapTables &&
          '[&_table]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere] [&_td]:[overflow-wrap:anywhere]',
        className
      )}
      data-tone={tone}
    >
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1
        // Stable keys so streaming deltas update `source` instead of remounting.
        return (
          <MemoMarkdownBlock
            key={`md-block-${block.start}`}
            source={block.source}
            openFenceBody={streaming && isLast ? openFenceBody : null}
            readOnlyTasks={readOnlyTasks}
          />
        )
      })}
    </div>
  )
}
