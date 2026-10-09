import { createContext, memo, useCallback, useContext, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeSanitize from 'rehype-sanitize'
import { IconButton, Kbd } from '@renderer/lib/ui'
import { useCopyFeedback } from '@renderer/lib/ui/CodeBlockCopyButton'
import { headingSections } from '@renderer/lib/markdown/headingSections'
import { allocateHeadingId, extractHeadingText } from '@renderer/lib/markdown/headingIds'
import { autolinkWorkspacePathsInProse, formatCitationsInProse } from '@shared/utils/linkableWorkspacePath'
import { closeEnd, completeTail, fenceMask, footnoteLabels, hidePendingNotes, splitBlocks } from './blocks'
import { CodeFence } from './code'
import { isMathClassName, MathTex, normalizeMathDelimiters } from './math'
import { Details, Img, Link, Quote, Summary, Table, TaskBox, Td, THead, Tr } from './elements'
import { rehypeAllowed, rehypeDecorate, SANITIZE_SCHEMA } from './plugins'
import { InlineCode, MdContext, useMd, type MdCtx } from './refs'
import { useSmoothText } from './smooth'
import './reply.css'

/*
  The agent's words in the record — a note between calls, a run's Result.

  Parsing is the app's (react-markdown + GFM, GitHub's sanitize schema). The
  presentation is reply.css plus the pieces a coding answer needs: code
  cards (file, lines, shell, diff, diagram, chart), workspace paths you can
  open, tables you can copy, alerts, folds and keys.

  Streaming renders block by block. Finished blocks are memoised by their
  text, so a new word re-renders the last block only; that last block is
  the only one made safe to read mid-sentence (blocks.ts), and the text is
  revealed smoothly rather than in the bursts it arrives in (smooth.ts).
*/

// A single `$` stays text: prices and shell variables are everywhere in an agent's prose (see math.tsx).
const remarkPlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['remarkPlugins']> = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }]
]
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [
  rehypeAllowed,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeDecorate
]
/** Images the app made itself (data:, blob:) keep their source; every other URL is checked as before. */
const urlTransform: UrlTransform = (url, key) =>
  key === 'src' && /^(?:data:image\/(?:png|jpe?g|gif|webp|avif);|blob:)/i.test(url) ? url : defaultUrlTransform(url)

export type ReplyMarkdownProps = {
  text: string
  streaming?: boolean
  /** `md` is the Result; `sm` a note between calls. */
  size?: 'sm' | 'md'
  /** `strong` is the one answer a surface exists to show; `secondary` prose under its own headings. */
  tone?: 'default' | 'secondary' | 'strong'
  /** Opens a workspace file, at a line when the reply names one. Absent: paths stay text. */
  onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
  /** Stable h1–h3 ids, for `#fragment` links within the reply (a table of contents). */
  headingIds?: boolean
  /** Prefix for those ids, so two replies with the same heading never share one. */
  headingIdScope?: string
  /** A copy control on each heading for the section under it. Off while streaming. */
  sectionCopy?: boolean
  className?: string
}

type Headings = {
  /** Slugs used so far and each heading's slug by where it sits — stable across StrictMode's second pass. */
  ids: { used: Map<string, number>; assigned: Map<string, string> } | null
  scope?: string
  /** Each heading's section, by the line it is on in the whole reply. */
  sections: ReadonlyMap<number, string> | null
}
const HeadingCtx = createContext<Headings>({ ids: null, sections: null })
/** Where the block being rendered starts: its offset (a key) and its first line. */
const BlockCtx = createContext<{ start: number; line: number }>({ start: 0, line: 0 })

export function ReplyMarkdown({
  text,
  streaming = false,
  size = 'sm',
  tone = 'default',
  onOpenWorkspaceFile,
  headingIds = false,
  headingIdScope,
  sectionCopy = false,
  className
}: ReplyMarkdownProps) {
  const { shown, live } = useSmoothText(text, streaming)
  const blocks = useMemo(() => splitBlocks(shown), [shown])
  const notes = useMemo(() => (live ? footnoteLabels(shown) : null), [live, shown])

  // Callers often pass an inline opener; a stable one keeps the finished blocks' memo.
  const openRef = useRef(onOpenWorkspaceFile)
  openRef.current = onOpenWorkspaceFile
  const canOpen = Boolean(onOpenWorkspaceFile)
  const open = useCallback((path: string, line?: number) => openRef.current?.(path, line ? { line } : undefined), [])
  const ctx = useMemo<MdCtx>(
    () => ({ streaming: live, open: canOpen ? open : undefined, scope: headingIds ? headingIdScope : undefined }),
    [live, canOpen, open, headingIds, headingIdScope]
  )

  const headings = useMemo<Headings>(() => {
    // Only a reply of more than one part: one heading's section is the whole of it.
    const found = sectionCopy && !live ? headingSections(shown) : null
    return {
      ids: headingIds ? { used: new Map(), assigned: new Map() } : null,
      scope: headingIdScope,
      sections: found && found.size >= 2 ? found : null
    }
  }, [sectionCopy, live, shown, headingIds, headingIdScope])

  if (!shown.trim()) return null

  return (
    <MdContext.Provider value={ctx}>
      <HeadingCtx.Provider value={headings}>
        <div
          className={['vy-reply', className].filter(Boolean).join(' ')}
          data-reply
          data-size={size}
          data-tone={tone}
          data-streaming={live || undefined}
        >
          {blocks.map((b, i) => {
            const last = i === blocks.length - 1
            const isOpen = live && last
            const pending = notes ? hidePendingNotes(b.source, notes) : b.source
            // Still being written: made safe to read mid-sentence. Finished: only what a stopped run left open closes.
            const tail = isOpen ? completeTail(pending) : last ? closeEnd(pending) : pending
            const source = linkPaths(tail, canOpen)
            return <Block key={b.start} source={source} start={b.start} line={lineAt(shown, b.start)} open={isOpen} />
          })}
        </div>
      </HeadingCtx.Provider>
    </MdContext.Provider>
  )
}

/** The line `offset` is on, counted from 0. */
function lineAt(text: string, offset: number): number {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * Bare `src/a.ts:42` and `[[src/a.ts:42]]` citations become links to open,
 * where something can open them; otherwise the citations still read as code.
 * Only prose is touched — never a fence's lines.
 */
function linkPaths(source: string, canOpen: boolean): string {
  const rewrite = canOpen ? autolinkWorkspacePathsInProse : formatCitationsInProse
  const lines = source.split('\n')
  const fenced = fenceMask(lines)
  const out: string[] = []
  let prose: string[] = []
  const flush = (): void => {
    if (prose.length) out.push(...rewrite(prose.join('\n')).split('\n'))
    prose = []
  }
  lines.forEach((line, i) => {
    if (fenced[i]) {
      flush()
      out.push(line)
    } else prose.push(line)
  })
  flush()
  return out.join('\n')
}

/** One block of the reply. `open`: the block the stream is still writing. */
const Block = memo(function Block({ source, start, line, open }: { source: string; start: number; line: number; open: boolean }) {
  const where = useMemo(() => ({ start, line }), [start, line])
  const text = useMemo(() => normalizeMathDelimiters(source), [source])
  if (!source.trim()) return null
  return (
    <div data-block data-open={open || undefined}>
      <OpenContext open={open} source={source}>
        <BlockCtx.Provider value={where}>
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={COMPONENTS} urlTransform={urlTransform}>
            {text}
          </ReactMarkdown>
        </BlockCtx.Provider>
      </OpenContext>
    </div>
  )
})

/** Only the open block streams; a finished fence above it is final and may draw. */
function OpenContext({ open, source, children }: { open: boolean; source: string; children: ReactNode }) {
  const ctx = useMd()
  const value = useMemo(() => ({ ...ctx, streaming: open, source }), [ctx, open, source])
  return <MdContext.Provider value={value}>{children}</MdContext.Provider>
}

type HastNode = { position?: { start?: { offset?: number; line?: number } } }

/** h1–h3: an id when the reply links to its own sections, and a copy control for a section of a long reply. */
function Heading({ tag: Tag, node, children }: { tag: 'h1' | 'h2' | 'h3'; node?: HastNode; children?: ReactNode }) {
  const { ids, scope, sections } = useContext(HeadingCtx)
  const block = useContext(BlockCtx)
  let id: string | undefined
  if (ids) {
    const offset = node?.position?.start?.offset
    const key = offset != null ? `${block.start}:${offset}` : null
    let slug = key ? ids.assigned.get(key) : undefined
    if (!slug) {
      slug = allocateHeadingId(extractHeadingText(children), ids.used)
      if (key) ids.assigned.set(key, slug)
    }
    id = scope ? `${scope}-${slug}` : slug
  }
  // The line it sits on in the whole reply: its block's first line, plus its own.
  const at = node?.position?.start?.line
  const section = sections && at != null ? sections.get(block.line + at - 1) : undefined
  if (!section) return <Tag id={id}>{children}</Tag>
  return (
    <Tag id={id} className="group/heading">
      {children}
      <SectionCopy text={section} />
    </Tag>
  )
}

/** Copy one section of a long reply — the part you want to paste on — beside its heading, shown on hover. */
function SectionCopy({ text }: { text: string }) {
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

type HastCode = { properties?: { className?: string[]; dataMeta?: string }; children?: { value?: string }[] }

function Pre({ node }: { node?: { children?: unknown[] } }) {
  // react-markdown hands `pre` the hast node; the fence's text, language and meta live on its `code` child.
  const code = (node?.children?.[0] ?? {}) as HastCode
  const lang = (code.properties?.className ?? []).find((c) => c.startsWith('language-'))?.slice(9) ?? ''
  const text = (code.children ?? []).map((c) => c.value ?? '').join('')
  const { streaming } = useMd()
  // `$$` on its own lines, or a ```math fence: display math.
  if (lang === 'math') return <MathTex tex={text} display />
  return <CodeFence lang={lang} meta={code.properties?.dataMeta} text={text} streaming={streaming} />
}

const COMPONENTS: Components = {
  h1: ({ node, children }) => (
    <Heading tag="h1" node={node as HastNode}>
      {children}
    </Heading>
  ),
  h2: ({ node, children }) => (
    <Heading tag="h2" node={node as HastNode}>
      {children}
    </Heading>
  ),
  h3: ({ node, children }) => (
    <Heading tag="h3" node={node as HastNode}>
      {children}
    </Heading>
  ),
  code: ({ className, children }) =>
    isMathClassName(className) ? <MathTex tex={String(children ?? '')} display={false} /> : <InlineCode>{children}</InlineCode>,
  pre: ({ node }) => <Pre node={node as { children?: unknown[] }} />,
  a: ({ href, children, node: _n, ...rest }) => (
    <Link href={href} {...(rest as Record<string, unknown>)}>
      {children}
    </Link>
  ),
  img: ({ src, alt }) => <Img src={typeof src === 'string' ? src : undefined} alt={alt} />,
  table: ({ node, children }) => <Table node={node as never}>{children}</Table>,
  thead: ({ children }) => <THead>{children}</THead>,
  tr: ({ children }) => <Tr>{children}</Tr>,
  td: ({ node: _n, children, ...rest }) => <Td {...(rest as { style?: CSSProperties; 'data-num'?: string })}>{children}</Td>,
  blockquote: ({ children, node: _n, ...rest }) => <Quote {...(rest as { 'data-alert'?: string })}>{children}</Quote>,
  details: ({ children, open }) => <Details open={open}>{children}</Details>,
  summary: ({ children }) => <Summary>{children}</Summary>,
  kbd: ({ children }) => <Kbd className="vy-reply-kbd">{children}</Kbd>,
  input: ({ checked }) => <TaskBox checked={checked} />
}
