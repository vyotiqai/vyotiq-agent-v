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
import { CodeBlockCopyButton, useCopyFeedback } from './CodeBlockCopyButton'
import { IconButton } from './IconButton'
import { MermaidDiagram } from './MermaidDiagram'
import { ChartBlock } from './ChartBlock'
import { parseChartSpec } from '@shared/chartSpec'
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
  extractHeadingText,
  slugifyHeading
} from '@renderer/lib/markdown/headingIds'
import {
  isSafeMarkdownHref,
  markdownSanitizeSchema,
  sanitizeHighlightedHtml
} from '@renderer/lib/markdown/markdownSanitize'
import {
  autolinkWorkspacePathsInProse,
  formatCitationsInProse,
  parseLinkableWorkspacePath,
  parseVyFileHref,
  VY_FILE_HREF_PREFIX
} from '@shared/utils/linkableWorkspacePath'
import { cn } from './cn'
import { scrollMotion } from '@renderer/lib/utils/motion'
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
 * Heading ids for one rendered document. `used` counts slugs so a repeated
 * heading gets `-1`, `-2`…; `assigned` remembers each heading's id by where it
 * sits, so rendering the same heading again (StrictMode's second pass, a
 * re-render with unchanged content) returns the id it already has instead of
 * allocating the next suffix.
 */
type HeadingIdState = { used: Map<string, number>; assigned: Map<string, string> }

/** The DOM id a heading slug gets under `scope` — the same rule both ways. */
function scopedHeadingId(scope: string | undefined, slug: string): string {
  return scope ? `${scope}-${slug}` : slug
}

function buildHeadingComponents(
  state: HeadingIdState | null,
  scope: string | undefined,
  blockStart: number,
  sections: ReadonlyMap<number, string> | null
) {
  const make =
    (Tag: 'h1' | 'h2' | 'h3') =>
    ({
      children,
      node
    }: {
      children?: React.ReactNode
      node?: { position?: { start?: { offset?: number; line?: number } } }
    }) => {
      let id: string | undefined
      if (state) {
        const offset = node?.position?.start?.offset
        const key = offset != null ? `${blockStart}:${offset}` : null
        let slug = key ? state.assigned.get(key) : undefined
        if (!slug) {
          slug = allocateHeadingId(extractHeadingText(children), state.used)
          if (key) state.assigned.set(key, slug)
        }
        id = scopedHeadingId(scope, slug)
      }
      // The line it sits on in the whole document: its block's first line, plus its own.
      const line = node?.position?.start?.line
      const section = sections && line != null ? sections.get(blockStart + line - 1) : undefined
      if (!section) return <Tag id={id}>{children}</Tag>
      return (
        <Tag id={id} className="group/heading">
          {children}
          <SectionCopyButton text={section} />
        </Tag>
      )
    }
  return { h1: make('h1'), h2: make('h2'), h3: make('h3') }
}

const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+\S/

/**
 * Each heading's section, by the line it is on: the heading and everything
 * under it up to the next heading of its level or above, as written. Headings
 * inside a fence are code, not sections.
 */
export function headingSections(markdown: string): Map<number, string> {
  const lines = markdown.split('\n')
  const heads: { line: number; level: number }[] = []
  let open: Parameters<typeof isFenceCloser>[1] | null = null
  lines.forEach((text, i) => {
    if (open) {
      if (isFenceCloser(text, open)) open = null
      return
    }
    const fence = parseFenceLine(text)
    if (fence) {
      open = fence.open
      return
    }
    const m = HEADING_LINE.exec(text)
    if (m) heads.push({ line: i, level: m[1]!.length })
  })
  const out = new Map<number, string>()
  heads.forEach((head, k) => {
    const next = heads.slice(k + 1).find((h) => h.level <= head.level)
    out.set(head.line, lines.slice(head.line, next ? next.line : lines.length).join('\n').trim())
  })
  return out
}

/**
 * Copy one section of a long answer — the part you want to paste on — beside
 * its heading, shown on hover like a code block's copy. In the heading, so
 * keyboard focus reaches it right after the words it copies.
 */
function SectionCopyButton({ text }: { text: string }) {
  const { copied, copyError, copy } = useCopyFeedback()
  return (
    <span
      className="-my-1 ml-1.5 inline-flex align-middle vy-transition opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/heading:opacity-100 [@media(hover:hover)]:group-focus-within/heading:opacity-100"
      data-section-copy
    >
      <IconButton
        icon={copied ? 'check' : 'copy'}
        label={copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy this section'}
        size="xs"
        tone="muted"
        onClick={() => copy(text)}
      />
    </span>
  )
}

/**
 * Scroll to what an in-document `#fragment` link names — looked up only inside
 * the link's own markdown body, so the same heading in another note never
 * answers. Tries the scoped heading id, its slug, then the raw id (a GFM
 * footnote's `user-content-fn-1`).
 */
function scrollToFragment(from: Element, scope: string | undefined, fragment: string): void {
  let raw = fragment
  try {
    raw = decodeURIComponent(fragment)
  } catch {
    /* keep the fragment as written */
  }
  const root = from.closest('.markdown-body')
  if (!root) return
  const wanted = [scopedHeadingId(scope, raw), scopedHeadingId(scope, slugifyHeading(raw)), raw]
  const withIds = Array.from(root.querySelectorAll<HTMLElement>('[id]'))
  for (const id of wanted) {
    const target = withIds.find((el) => el.id === id)
    if (target) {
      target.scrollIntoView?.({ block: 'start', behavior: scrollMotion() })
      return
    }
  }
}

/**
 * Inline code, with no filled rectangle behind it. The mono face, the step-down
 * ink the markdown stylesheet gives it, and a hairline under the text are what
 * say "code" — a `bg-surface` box made a paragraph naming a dozen files read as a
 * row of grey tiles, and the fill also forced a hover fill to stay legible.
 * `BORDER_DIVIDER` is the named quiet-grey weight, so nothing here invents a
 * colour (CLAUDE.md: never hardcode one, never reach for a new opacity). Hover is
 * an underline, not a fill: with no surface behind it there is nothing to
 * deepen, and a fill would be a weight the design system does not name on a
 * control that is otherwise plain text.
 */
const CODE_BASE = 'rounded-sm border-b border-border/60 px-1 py-0.5 font-mono text-[0.85em]'
const CODE_CHIP = `${CODE_BASE} hover:underline focus-visible:vy-focus-ring`

function formatLinkablePathText(parsed: { path: string; line?: number }): string {
  return parsed.line != null ? `${parsed.path}:${parsed.line}` : parsed.path
}

function buildMarkdownComponents(
  openFenceBody: string | null,
  opts?: {
    headingIds?: boolean
    headingState?: HeadingIdState
    headingIdScope?: string
    blockStart?: number
    readOnlyTasks?: boolean
    onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
    sections?: ReadonlyMap<number, string> | null
  }
) {
  const headingIdScope = opts?.headingIdScope
  const idState = opts?.headingIds && opts.headingState ? opts.headingState : null
  const sections = opts?.sections ?? null
  const heading =
    idState || sections ? buildHeadingComponents(idState, headingIdScope, opts?.blockStart ?? 0, sections) : null
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
            data-code-chip
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
      if (idState && href?.startsWith('#') && href.length > 1 && !href.startsWith(VY_FILE_HREF_PREFIX)) {
        // An in-document link (a table of contents): scroll to the heading in
        // this body. As a new-window link it would open nothing.
        const fragment = href.slice(1)
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              scrollToFragment(event.currentTarget, headingIdScope, fragment)
            }}
            className="rounded-sm text-muted underline focus-visible:vy-focus-ring"
          >
            {children}
          </a>
        )
      }
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
      const text = String(children ?? '').trim()
      const parsed = parseLinkableWorkspacePath(text)
      if (parsed && onOpenWorkspaceFile && text === formatLinkablePathText(parsed)) {
        return (
          <button
            type="button"
            className={CODE_CHIP}
            data-code-chip
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
  headingIds,
  headingState,
  headingIdScope,
  blockStart,
  readOnlyTasks,
  linkWorkspacePaths,
  onOpenWorkspaceFile,
  sections
}: {
  source: string
  openFenceBody: string | null
  headingIds?: boolean
  headingState?: HeadingIdState
  headingIdScope?: string
  blockStart: number
  readOnlyTasks?: boolean
  linkWorkspacePaths?: boolean
  onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
  sections?: ReadonlyMap<number, string> | null
}) {
  const renderedSource = useMemo(() => {
    if (parseFenceLine(source.split('\n')[0] ?? '')) return source
    // `[[path:line]]` citations read as code even where nothing opens files.
    return linkWorkspacePaths ? autolinkWorkspacePathsInProse(source) : formatCitationsInProse(source)
  }, [linkWorkspacePaths, source])
  const components = useMemo(
    () =>
      buildMarkdownComponents(openFenceBody, {
        headingIds,
        headingState,
        headingIdScope,
        blockStart,
        readOnlyTasks,
        onOpenWorkspaceFile,
        sections
      }),
    [openFenceBody, headingIds, headingState, headingIdScope, blockStart, readOnlyTasks, onOpenWorkspaceFile, sections]
  )
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {renderedSource}
    </Markdown>
  )
})

/** Every size reads on the scale's relaxed line; `md` is the prose default. */
const MARKDOWN_SIZE = {
  caption: 'text-caption leading-relaxed',
  sm: 'text-sm leading-relaxed',
  md: 'text-md leading-relaxed'
} as const

const MARKDOWN_TONE = {
  default: 'text-fg',
  secondary: 'text-secondary',
  strong: 'text-fg-strong'
} as const

export function MarkdownContent({
  content,
  streaming = false,
  headingIds = false,
  headingIdScope,
  wrapTables = false,
  readOnlyTasks = false,
  linkWorkspacePaths = false,
  onOpenWorkspaceFile,
  size = 'sm',
  tone = 'default',
  sectionCopy = false,
  className
}: {
  content: string
  streaming?: boolean
  /** Stable h1–h3 ids for in-panel outline scroll (plan docs) and `#fragment` links. */
  headingIds?: boolean
  /**
   * Prefix for heading ids (`<scope>-<slug>`), so two bodies on one page with
   * the same heading never share a DOM id. A `#slug` link inside the body still
   * finds its own heading. Omit for bare slugs (a panel that computes them itself).
   */
  headingIdScope?: string
  /** Allow table cells to wrap (narrow plan/contract dock). */
  wrapTables?: boolean
  /** Disable GFM task checkboxes (display-only). */
  readOnlyTasks?: boolean
  /** Auto-link bare workspace-relative paths in prose. */
  linkWorkspacePaths?: boolean
  onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
  /**
   * Body text size. The root owns size, leading and colour, so a class on a
   * wrapper (or in `className`) never reaches the text — pass these instead.
   * `md` is the record's Result; `caption` is prose inside a tool body.
   */
  size?: 'caption' | 'sm' | 'md'
  /**
   * Body text colour. `secondary` is prose under its own headings (the Plan
   * tab, a record note); `strong` is the one answer a surface exists to show.
   */
  tone?: 'default' | 'secondary' | 'strong'
  /**
   * A copy control on each heading for the section under it — for a long
   * answer of several parts. Off while streaming: the sections are still moving.
   */
  sectionCopy?: boolean
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
  // `markdown` is an intentional reset key: fresh state per content change keeps
  // heading-id counters deterministic across edits.
  const headingState = useMemo<HeadingIdState | undefined>(
    () => (headingIds ? { used: new Map(), assigned: new Map() } : undefined),
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
  // Only an answer of more than one part: one heading's section is the whole of it.
  const sections = useMemo(() => {
    if (!sectionCopy || streaming) return null
    const found = headingSections(markdown)
    return found.size >= 2 ? found : null
  }, [sectionCopy, streaming, markdown])
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
        headingIds && 'markdown-body--heading-ids',
        className
      )}
      data-tone={tone}
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
            headingState={headingState}
            headingIdScope={headingIdScope}
            blockStart={block.start}
            readOnlyTasks={readOnlyTasks}
            linkWorkspacePaths={linkWorkspacePaths}
            onOpenWorkspaceFile={linkWorkspacePaths ? openWorkspaceFileStable : undefined}
            sections={sections}
          />
        )
      })}
    </div>
  )
}
