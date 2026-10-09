import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react'
import { announceLive } from '@renderer/lib/a11y/useLiveAnnouncer'
import { Icon, type IconName } from '@renderer/lib/icons'
import { ActionMenu, CheckMark, cn } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { isSafeMarkdownHref } from '@renderer/lib/markdown/markdownSanitize'
import { slugifyHeading } from '@renderer/lib/markdown/headingIds'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { scrollMotion } from '@renderer/lib/utils/motion'
import { parseVyFileHref } from '@shared/utils/linkableWorkspacePath'
import { FileRef, InLink, parsePath, useMd } from './refs'

/*
  The block elements beyond plain prose. Each one exists because a coding
  answer needs it, and each says what it is with a shape or an icon and a
  word — never with colour alone.
*/

type Hast = { type: string; tagName?: string; value?: string; children?: Hast[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const textOf = (n: Hast): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''))

/* ─── Tables ─────────────────────────────────────────────────────────────── */

/** Rows of cell text, header first — what Copy hands over. */
function cellsOf(table: Hast | undefined): string[][] {
  const rows: string[][] = []
  const visit = (n: Hast): void => {
    if (n.tagName === 'tr') rows.push((n.children ?? []).filter((c) => c.tagName === 'th' || c.tagName === 'td').map((c) => textOf(c).trim()))
    else (n.children ?? []).forEach(visit)
  }
  if (table) visit(table)
  return rows
}

const toMarkdown = (rows: string[][]): string =>
  rows.map((r, i) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |${i === 0 ? `\n|${r.map(() => ' --- ').join('|')}|` : ''}`).join('\n')
const toCsv = (rows: string[][]): string => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')

/** The table as it was written — alignment, code and links kept — out of its block's source. */
function sourceOf(table: Hast | undefined, source: string | undefined): string | null {
  const from = table?.position?.start.offset
  const to = table?.position?.end.offset
  if (source === undefined || from === undefined || to === undefined) return null
  // The paths the renderer linked itself go back to the words the agent wrote.
  const lines = source
    .slice(from, to)
    .replace(/\[([^\]\n]*)\]\(#vy-file:[^)\s]*\)/g, '$1')
    .split('\n')
  // A table inside a list item is indented; its copy is not.
  const indent = Math.min(...lines.slice(1).map((l) => l.length - l.trimStart().length))
  return lines.map((l, i) => (i === 0 ? l : l.slice(indent))).join('\n')
}

type TableData = { head: boolean; rows: () => string[][]; markdown: () => string }
const TableCtx = createContext<TableData | null>(null)

export function Table({ node, children }: { node?: Hast; children?: ReactNode }) {
  const { source } = useMd()
  const data: TableData = {
    head: false,
    rows: () => cellsOf(node),
    markdown: () => sourceOf(node, source) ?? toMarkdown(cellsOf(node))
  }
  return (
    <div className="vy-reply-table group/table">
      <TableCtx.Provider value={data}>
        <table>{children}</table>
      </TableCtx.Provider>
    </div>
  )
}

export function THead({ children }: { children?: ReactNode }) {
  const ctx = useContext(TableCtx)
  return (
    <thead>
      <TableCtx.Provider value={ctx && { ...ctx, head: true }}>{children}</TableCtx.Provider>
    </thead>
  )
}

/**
 * Every row ends in a narrow column that holds Copy in the header — so the
 * control never sits on top of a right-aligned number.
 */
export function Tr({ children }: { children?: ReactNode }) {
  const ctx = useContext(TableCtx)
  return (
    <tr>
      {children}
      {ctx?.head ? (
        <th className="vy-reply-table-actions">
          <TableCopy table={ctx} />
        </th>
      ) : (
        <td className={cn('vy-reply-table-actions', BORDER_DIVIDER)} />
      )}
    </tr>
  )
}

/** A body cell: its rule between rows is the named divider weight (BORDER_DIVIDER), not a mixed colour. */
export function Td({ children, ...rest }: { children?: ReactNode; style?: CSSProperties; 'data-num'?: string }) {
  return (
    <td {...rest} className={BORDER_DIVIDER}>
      {children}
    </td>
  )
}

function TableCopy({ table }: { table: TableData }) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  const copy = (text: string): void =>
    void copyText(text).then((ok) => {
      announceLive(ok ? 'Table copied' : 'Copy failed', ok ? 'polite' : 'assertive')
      if (!ok) return
      setDone(true)
      window.setTimeout(() => setDone(false), 1400)
    })
  return (
    <ActionMenu
      open={open}
      onOpenChange={setOpen}
      align="end"
      aria-label="Copy table"
      items={[
        { id: 'md', label: 'Copy as Markdown', onSelect: () => copy(table.markdown()) },
        { id: 'csv', label: 'Copy as CSV', onSelect: () => copy(toCsv(table.rows())) }
      ]}
      trigger={(t) => (
        <button
          {...t}
          type="button"
          title="Copy table"
          className={cn(
            // An inset ring: the button sits at the edge of a box that scrolls, which would cut an outer one.
            'inline-grid size-6 place-items-center rounded-md text-tertiary hover:bg-surface hover:text-fg focus-visible:vy-focus-ring-inset',
            open || done ? 'opacity-100' : 'opacity-0 group-hover/table:opacity-100 group-focus-within/table:opacity-100'
          )}
        >
          <Icon name={done ? 'check' : 'copy'} size={12} />
        </button>
      )}
    />
  )
}

/* ─── Alerts and quotes ──────────────────────────────────────────────────── */

const ALERTS: Record<string, { icon: IconName; label: string; tone: string }> = {
  note: { icon: 'info', label: 'Note', tone: 'vy-reply-alert-accent' },
  tip: { icon: 'sparkles', label: 'Tip', tone: 'vy-reply-alert-success' },
  important: { icon: 'flag', label: 'Important', tone: 'vy-reply-alert-accent' },
  warning: { icon: 'warning', label: 'Warning', tone: 'vy-reply-alert-warning' },
  caution: { icon: 'warningCircle', label: 'Caution', tone: 'vy-reply-alert-danger' }
}

export function Quote({ children, ...props }: { children?: ReactNode; 'data-alert'?: string }) {
  const alert = ALERTS[props['data-alert'] ?? '']
  if (!alert) return <blockquote>{children}</blockquote>
  return (
    <div className={cn('vy-reply-alert', alert.tone)} role="note" aria-label={alert.label}>
      <Icon name={alert.icon} size={14} className="vy-reply-alert-icon" />
      <p className="vy-reply-alert-label">{alert.label}</p>
      <div className="vy-reply-alert-body">{children}</div>
    </div>
  )
}

/* ─── Folds, keys, links, images, task boxes ─────────────────────────────── */

export function Details({ children, open }: { children?: ReactNode; open?: boolean }) {
  return (
    <details className="vy-reply-details group/details" open={open}>
      {children}
    </details>
  )
}

export function Summary({ children }: { children?: ReactNode }) {
  return (
    <summary className="focus-visible:vy-focus-ring">
      <Icon name="chevronRight" size={12} className="shrink-0 text-tertiary transition-transform group-open/details:rotate-90" />
      <span>{children}</span>
    </summary>
  )
}

type LinkProps = {
  href?: string
  children?: ReactNode
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
  'data-footnote-ref'?: unknown
  'data-footnote-backref'?: unknown
}

const LINK = 'focus-visible:vy-focus-ring'

const safeDecode = (s: string): string => {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

/**
 * Scroll to what an in-answer `#fragment` names — looked up only inside this
 * reply, so the same heading in another note never answers. Tries the scoped
 * heading id, its slug, then the raw id and GFM's prefixed one (a footnote's
 * `user-content-fn-1`).
 */
function scrollToFragment(from: Element, scope: string | undefined, fragment: string): void {
  let raw = fragment
  try {
    raw = decodeURIComponent(fragment)
  } catch {
    /* keep the fragment as written */
  }
  const root = from.closest('[data-reply]')
  if (!root) return
  const scoped = (slug: string): string => (scope ? `${scope}-${slug}` : slug)
  const wanted = [scoped(raw), scoped(slugifyHeading(raw)), raw, `user-content-${raw}`]
  const withIds = Array.from(root.querySelectorAll<HTMLElement>('[id]'))
  for (const id of wanted) {
    const target = withIds.find((el) => el.id === id)
    if (target) {
      target.scrollIntoView?.({ block: 'start', behavior: scrollMotion() })
      return
    }
  }
}

export function Link({ href, children, id, ...rest }: LinkProps) {
  const { open, scope } = useMd()
  // Footnote marks carry the id their back-link scrolls to, and a label that says where it goes.
  const keep = { id, 'aria-label': rest['aria-label'], 'aria-describedby': rest['aria-describedby'] }
  // A path the renderer linked (`#vy-file:`), or a relative link the agent wrote to a file: it opens there.
  const vyFile = parseVyFileHref(href)
  if (vyFile && open) return <FileRef path={vyFile.path} line={vyFile.line} />
  if (vyFile) return <span {...keep}>{children}</span>
  const local = href && !href.startsWith('#') && !/^[a-z][a-z\d+.-]*:/i.test(href) ? parsePath(safeDecode(href)) : null
  if (local && open) {
    return (
      <button
        type="button"
        {...keep}
        data-code-chip
        className={cn('vy-reply-pathlink', LINK)}
        title={`Open ${local.path}${local.line ? ` at line ${local.line}` : ''}`}
        onClick={() => open(local.path, local.line)}
      >
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </button>
    )
  }
  if (!isSafeMarkdownHref(href)) return <span {...keep}>{children}</span>
  if (href.startsWith('#')) {
    // In-answer links (a table of contents, footnotes): scroll within this reply, never open a window.
    const footnote = rest['data-footnote-ref'] !== undefined || rest['data-footnote-backref'] !== undefined
    return (
      <a
        href={href}
        {...keep}
        className={cn(LINK, footnote ? 'vy-reply-footref' : '')}
        onClick={(e) => {
          e.preventDefault()
          scrollToFragment(e.currentTarget, scope, href.slice(1))
        }}
      >
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </a>
    )
  }
  return (
    <a href={href} {...keep} target="_blank" rel="noreferrer noopener" className={LINK}>
      <InLink.Provider value={true}>{children}</InLink.Provider>
    </a>
  )
}

/**
 * Images. Only what the app itself made (data:, blob:) loads; a remote URL
 * the model wrote is a request to someone else's server, so it shows as a
 * link to open instead — never fetched behind your back.
 */
export function Img({ src, alt }: { src?: string; alt?: string }) {
  if (src && /^(?:data:image\/|blob:)/.test(src)) return <img src={src} alt={alt ?? ''} className="vy-reply-img" />
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted', BORDER_DIVIDER)}>
      <Icon name="image" size={12} className="text-tertiary" />
      {alt || 'Image'}
      {src && isSafeMarkdownHref(src) ? (
        <a href={src} target="_blank" rel="noreferrer noopener" className={cn('text-accent', LINK)}>
          Open
        </a>
      ) : null}
    </span>
  )
}

export function TaskBox({ checked }: { checked?: boolean }) {
  return (
    <span className="vy-reply-task" data-checked={checked ? '' : undefined}>
      <CheckMark on={!!checked} />
      <span className="sr-only">{checked ? 'Done:' : 'Not done:'}</span>
    </span>
  )
}
