import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { CodeToken } from '@renderer/lib/markdown/markdownHighlight'
import { useDiffHighlight } from '@renderer/features/chat/components/useDiffHighlight'
import type { DiffLayout } from '@renderer/features/chat/components/DiffPreview'
import {
  lineLabel,
  parseReviewDiff,
  splitRows,
  unifiedRows,
  type ReviewLine,
  type SplitRow,
  type UnifiedRow
} from './reviewDiff'

/** A line someone asked about: which file, which line, and on which side of the change. */
export type AskTarget = { path: string; line: ReviewLine; side: 'old' | 'new' }

const ROW_BG: Record<ReviewLine['kind'], string> = { ctx: '', add: 'diff-row-add', del: 'diff-row-del' }
const SIGN: Record<ReviewLine['kind'], string> = { ctx: '', add: '+', del: '−' }

function Code({ line, tokens }: { line: ReviewLine; tokens?: readonly CodeToken[] }) {
  if (!tokens?.length) return <>{line.text || ' '}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={token.color ? { color: token.color } : undefined}>
          {token.text}
        </span>
      ))}
    </>
  )
}

function matches(line: ReviewLine | null, q: string): boolean {
  return Boolean(line && line.text.toLowerCase().includes(q))
}

/**
 * A file's diff as a table: hunk headers as rows, numbers in the gutter and a
 * +/− sign beside every changed line (tint is never the only cue). Split sets
 * removed lines against the lines that replaced them. With `onAsk`, a line's
 * number opens a line under it to ask the agent about that line.
 */
export function ReviewDiffTable({
  path,
  diff,
  layout,
  wordWrap = false,
  numbers = 'new',
  findQuery = '',
  onAsk
}: {
  path: string
  diff: string
  layout: DiffLayout
  wordWrap?: boolean
  /** Unified only: the new file's numbers, or old and new side by side. */
  numbers?: 'new' | 'both'
  findQuery?: string
  onAsk?: (target: AskTarget, question: string) => void
}) {
  const parsed = useMemo(() => parseReviewDiff(diff), [diff])
  const tokens = useDiffHighlight(parsed.flat, path)
  const [asking, setAsking] = useState<{ rowKey: string; target: AskTarget } | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  // A different file or a changed diff closes the question. Compared during
  // render rather than in an effect: an effect also ran just after mount, and a
  // click that landed before it flushed (a slow machine) was undone by it.
  const [shown, setShown] = useState({ diff, path })
  if (shown.diff !== diff || shown.path !== path) {
    setShown({ diff, path })
    setAsking(null)
    setSent(null)
  }

  const q = findQuery.trim().toLowerCase()
  const split = layout === 'split'
  const rows = useMemo(() => {
    const all: Array<SplitRow | UnifiedRow> = split ? splitRows(parsed) : unifiedRows(parsed)
    if (!q) return all
    return all.filter((row) =>
      row.type === 'hunk'
        ? true
        : 'line' in row
          ? matches(row.line, q)
          : matches(row.left, q) || matches(row.right, q)
    )
  }, [parsed, q, split])
  const cols = split ? 6 : numbers === 'both' ? 4 : 3
  // Unwrapped, unified lines run on and the pane scrolls sideways; split keeps
  // two equal halves, so a line too long for its half ends in an ellipsis
  // (whole on hover) rather than pushing the new side off screen.
  const textCell = wordWrap
    ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
    : split
      ? 'overflow-hidden text-ellipsis whitespace-pre'
      : 'whitespace-pre'

  const number = (line: ReviewLine, side: 'old' | 'new', rowKey: string, className: string) => {
    const n = side === 'old' ? line.oldN : line.newN
    return (
      <td className={cn('select-none text-right align-top text-tertiary tnum', className)}>
        {onAsk && n != null ? (
          <button
            type="button"
            className="w-full text-right tnum hover:text-fg focus-visible:vy-focus-ring"
            aria-label={`Ask about line ${n}${side === 'old' ? ' before the change' : ''}`}
            onClick={() => {
              setSent(null)
              setAsking({ rowKey, target: { path, line, side } })
            }}
          >
            {n}
          </button>
        ) : (
          (n ?? '')
        )}
      </td>
    )
  }

  const cells = (line: ReviewLine | null, side: 'old' | 'new', rowKey: string) => {
    if (!line) {
      return (
        <>
          <td className="bg-surface" />
          <td className="bg-surface" />
          <td className="bg-surface" />
        </>
      )
    }
    const bg = ROW_BG[line.kind]
    return (
      <>
        {number(line, side, rowKey, cn('pr-2', bg))}
        <td className={cn('select-none align-top', bg, line.kind === 'add' ? 'text-success' : 'text-danger')}>
          {SIGN[line.kind]}
        </td>
        <td className={cn('pr-4 align-top text-fg', bg, textCell)} title={wordWrap ? undefined : line.text}>
          <Code line={line} tokens={tokens.get(line.i)} />
        </td>
      </>
    )
  }

  return (
    <>
      <table
        className={cn('border-collapse', split || wordWrap ? 'w-full table-fixed' : 'w-max min-w-full')}
        data-review-diff={layout}
      >
        <colgroup>
          {split ? (
            <>
              <col className="w-10" />
              <col className="w-4" />
              <col />
              <col className="w-10" />
              <col className="w-4" />
              <col />
            </>
          ) : (
            <>
              <col className="w-9" />
              {numbers === 'both' ? <col className="w-9" /> : null}
              <col className="w-5" />
              <col />
            </>
          )}
        </colgroup>
        <tbody>
          {rows.map((row) => {
            if (row.type === 'hunk') {
              return (
                <tr key={row.key} className="bg-surface">
                  <td colSpan={cols} className="px-3 py-0.5 text-muted">
                    <div className={split || wordWrap ? 'truncate' : 'whitespace-pre'} title={row.header}>
                      {row.header}
                    </div>
                  </td>
                </tr>
              )
            }
            let body
            if ('line' in row) {
              const { line } = row
              // Unified tints the whole row, as the mockup's DiffView does.
              body = (
                <tr className={ROW_BG[line.kind]} data-diff-line={line.kind}>
                  {numbers === 'both' ? number(line, 'old', row.key, 'pr-1') : null}
                  {number(line, 'new', row.key, 'pr-1')}
                  <td
                    className={cn(
                      'select-none text-center align-top',
                      line.kind === 'add' ? 'text-success' : line.kind === 'del' ? 'text-danger' : 'text-tertiary'
                    )}
                  >
                    {SIGN[line.kind]}
                  </td>
                  <td className={cn('pr-4 align-top text-fg', textCell)}>
                    <Code line={line} tokens={tokens.get(line.i)} />
                  </td>
                </tr>
              )
            } else {
              body = (
                <tr data-diff-line={row.left?.kind === 'ctx' ? 'ctx' : 'change'}>
                  {cells(row.left, 'old', row.key)}
                  {cells(row.right, 'new', row.key)}
                </tr>
              )
            }
            const askingHere = asking?.rowKey === row.key
            return (
              <Fragment key={row.key}>
                {body}
                {askingHere && onAsk ? (
                  <tr>
                    <td colSpan={cols} className="p-0">
                      <AskLine
                        n={lineLabel(asking.target.line)}
                        before={asking.target.side === 'old' && asking.target.line.kind !== 'ctx'}
                        onClose={() => setAsking(null)}
                        onSend={(question) => {
                          onAsk(asking.target, question)
                          setSent(row.key)
                          setAsking(null)
                        }}
                      />
                    </td>
                  </tr>
                ) : sent === row.key ? (
                  <tr>
                    <td colSpan={cols} className="p-0">
                      <p
                        className="my-2 flex h-9 items-center gap-2 border-y border-border bg-bg px-4 font-sans text-sm text-muted"
                        role="status"
                      >
                        <Icon name="check" size={13} className="text-success" />
                        Sent to the agent
                      </p>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {parsed.truncated ? (
        <p className="m-0 px-3 py-2 font-sans text-xs text-muted">Only the first {parsed.flat.length} lines are shown.</p>
      ) : null}
    </>
  )
}

function AskLine({
  n,
  before,
  onSend,
  onClose
}: {
  n: number
  before: boolean
  onSend: (question: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // A line was just picked to ask about; the question goes here.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && value.trim()) {
      event.preventDefault()
      onSend(value.trim())
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }
  return (
    <div className="my-2 flex h-9 items-center gap-2.5 border-y border-border bg-bg px-4 font-sans text-sm">
      <span className="font-mono text-caption text-tertiary">L{n}</span>
      <span className="font-mono text-accent" aria-hidden>
        ›
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!value.trim()) onClose()
        }}
        className="min-w-0 flex-1 rounded-sm bg-transparent text-sm text-fg outline-none placeholder:text-tertiary focus-visible:vy-focus-ring"
        placeholder="Ask about or change this line — goes to the agent as a follow-up"
        aria-label={`Ask the agent about line ${n}${before ? ' before the change' : ''}`}
      />
    </div>
  )
}
