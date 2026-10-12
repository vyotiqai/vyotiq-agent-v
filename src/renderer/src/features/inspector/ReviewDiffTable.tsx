import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, cn } from '@renderer/lib/ui'
import type { CodeToken } from '@renderer/lib/markdown/markdownHighlight'
import { diffFingerprint, hunkIdentity, parseUnifiedHunks, type HunkIdentity } from '@shared/utils/hunkPatch'
import { useDiffHighlight } from '@renderer/features/chat/components/useDiffHighlight'
import type { DiffLayout } from '@renderer/features/chat/components/DiffPreview'
import { changedCount, linesLeftOut } from '@renderer/features/chat/components/linesLeftOut'
import {
  lineLabel,
  parseReviewDiff,
  splitRows,
  unifiedRows,
  type ReviewLine,
  type SplitRow,
  type UnifiedRow
} from './reviewDiff'

/**
 * A line someone asked about: which file, which line, and on which side of the
 * change. `lines` is a range picked with Shift+click: every line from the
 * first to `line`, in the diff's order, on that side.
 */
export type AskTarget = { path: string; line: ReviewLine; side: 'old' | 'new'; lines?: ReviewLine[] }

/**
 * A review in progress, provided by the Changes panel: comments collect here
 * and go to the agent as one instruction. Every diff table under it offers
 * "Add to review" without the panel passing it through each list.
 */
export const ReviewCommentsContext = createContext<{
  onQueue?: (target: AskTarget, comment: string) => void
  queuedLines?: ReadonlySet<string>
}>({})

/** The key a queued comment marks its line by. */
export function askLineKey(path: string, side: 'old' | 'new', line: ReviewLine): string {
  return `${path}\u0000${side}\u0000${side === 'old' ? line.oldN : line.newN}`
}

/**
 * One hunk of the diff on screen, named so main can find it again: where it
 * sits and what it says, and the fingerprint of the whole diff it was read in.
 */
export type HunkTarget = { path: string; hunk: HunkIdentity; diffHash: string }

/**
 * What a hunk header row offers. Undo takes the hunk back out of the file;
 * Stage and Unstage move it into or out of git's index (the file itself does
 * not change). Viewed is a mark of your own, as a file's is (a hunk has no
 * Keep: Keep settles a whole write, and a hunk left in is simply kept with its file).
 */
export type HunkActions = {
  /** Runs the row's action — Undo unless `kind` says otherwise. */
  onUndo: (target: HunkTarget) => void
  kind?: HunkActionKind
  busy?: boolean
  /** Why the action cannot run now (a live run); the button stays, disabled, and says so. */
  blockedReason?: string | null
  isViewed?: (target: HunkTarget) => boolean
  onViewed?: (target: HunkTarget, viewed: boolean) => void
}

export type HunkActionKind = 'undo' | 'stage' | 'unstage'

const HUNK_ACTION: Record<HunkActionKind, { icon: 'undo' | 'plus' | 'minus'; verb: string; title: string }> = {
  undo: { icon: 'undo', verb: 'Undo', title: 'Undo this hunk — put these lines back as they were' },
  stage: { icon: 'plus', verb: 'Stage', title: 'Stage this hunk — the rest of the file stays unstaged' },
  unstage: { icon: 'minus', verb: 'Unstage', title: 'Unstage this hunk — it stays in the file, unstaged' }
}

/** Shown on hover or when focus is inside the row; still in the tab order while hidden. */
const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'

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
 * number opens a line under it to ask the agent about that line. With
 * `hunkActions`, each hunk header offers Undo (and Viewed) on hover or focus.
 *
 * A new file is all additions, so the tint would say the same thing on every
 * row: it drops the wash and the old side (split and the old numbers), and
 * keeps the + gutter and one number column.
 */
export function ReviewDiffTable({
  path,
  diff,
  layout,
  wordWrap = false,
  numbers: numbersAsked = 'new',
  findQuery = '',
  added: addedFile = false,
  onAsk,
  onQueue: onQueueProp,
  queuedLines: queuedLinesProp,
  hunkActions
}: {
  path: string
  diff: string
  layout: DiffLayout
  wordWrap?: boolean
  /** Unified only: the new file's numbers, or old and new side by side. */
  numbers?: 'new' | 'both'
  findQuery?: string
  /** The file is new; git's `@@ -0,0` header says so too when this is left out. */
  added?: boolean
  onAsk?: (target: AskTarget, question: string) => void
  /**
   * Add the comment to a review sent later as one instruction, instead of
   * sending it now (Ctrl/Cmd+Enter, or Add to review; Enter still sends).
   */
  onQueue?: (target: AskTarget, comment: string) => void
  /** Lines with a comment waiting in the review (`askLineKey`), marked in the gutter. */
  queuedLines?: ReadonlySet<string>
  /** Per-hunk Undo and Viewed on each hunk header; a new file is one hunk and gets none. */
  hunkActions?: HunkActions
}) {
  const review = useContext(ReviewCommentsContext)
  const onQueue = onQueueProp ?? review.onQueue
  const queuedLines = queuedLinesProp ?? review.queuedLines
  const parsed = useMemo(() => parseReviewDiff(diff), [diff])
  // Past the cap, the changed lines it dropped: parsed again without one, and
  // only when there is a cut to count.
  const hiddenChanged = useMemo(
    () => (parsed.truncated ? changedCount(parseReviewDiff(diff, Infinity).flat) - changedCount(parsed.flat) : 0),
    [diff, parsed]
  )
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
  const added = addedFile || (parsed.hunks.length > 0 && parsed.hunks.every((h) => h.header.startsWith('@@ -0,0 ')))
  const split = layout === 'split' && !added
  const numbers = added ? 'new' : numbersAsked
  // Each hunk named from the whole diff, not the capped parse: a hunk the cap
  // cut short is still named by all of its lines. Keys follow the same order.
  // A diff main cut short cannot be staged part by part: git's own copy of it
  // would not match, and main refuses it. No Stage/Unstage rather than one that always fails.
  const indexCapped = hunkActions?.kind !== undefined && hunkActions.kind !== 'undo' && diff.trimEnd().endsWith('[diff truncated]')
  const withHunkActions = Boolean(hunkActions) && !added && !indexCapped
  const hunkTargets = useMemo(() => {
    if (!withHunkActions) return null
    const diffHash = diffFingerprint(diff)
    return new Map<string, HunkTarget>(
      parseUnifiedHunks(diff).map((hunk, index) => [`h${index}`, { path, hunk: hunkIdentity(hunk), diffHash }])
    )
  }, [withHunkActions, diff, path])
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

  /**
   * Shift+click on a second line of the same side, with a question open:
   * the question covers every line between, and moves under the last.
   */
  const rangeTo = (line: ReviewLine, side: 'old' | 'new'): ReviewLine[] | null => {
    if (!asking || asking.target.side !== side) return null
    const from = asking.target.lines?.[0] ?? asking.target.line
    const lo = Math.min(from.i, line.i)
    const hi = Math.max(from.i, line.i)
    const onSide = (l: ReviewLine): boolean => (side === 'old' ? l.oldN != null : l.newN != null)
    const lines = parsed.hunks.flatMap((h) => h.lines).filter((l) => l.i >= lo && l.i <= hi && onSide(l))
    return lines.length > 1 ? lines : null
  }

  const number = (line: ReviewLine, side: 'old' | 'new', rowKey: string, className: string) => {
    const n = side === 'old' ? line.oldN : line.newN
    const queued = n != null && queuedLines?.has(askLineKey(path, side, line))
    return (
      <td className={cn('select-none text-right align-top text-tertiary tnum', className)}>
        {onAsk && n != null ? (
          <button
            type="button"
            className={cn(
              'w-full text-right tnum hover:text-fg focus-visible:vy-focus-ring',
              queued ? 'font-semibold text-accent' : ''
            )}
            aria-label={`Ask about line ${n}${side === 'old' ? ' before the change' : ''}${queued ? ' (has a review comment)' : ''}`}
            title={onQueue ? 'Comment on this line · Shift+click another line for a range' : undefined}
            onClick={(event) => {
              setSent(null)
              const range = event.shiftKey ? rangeTo(line, side) : null
              if (range) {
                const last = range[range.length - 1]!
                setAsking({ rowKey, target: { path, line: last, side, lines: range } })
                return
              }
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
        data-review-new={added ? '' : undefined}
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
              const target = hunkTargets?.get(row.key)
              const headerText = split || wordWrap ? 'truncate' : 'whitespace-pre'
              if (!target || !hunkActions) {
                return (
                  <tr key={row.key} className="bg-surface">
                    <td colSpan={cols} className="px-3 py-0.5 text-muted">
                      <div className={headerText} title={row.header}>
                        {row.header}
                      </div>
                    </td>
                  </tr>
                )
              }
              const viewed = hunkActions.isViewed?.(target) ?? false
              const at = target.hunk.newStart
              const action = HUNK_ACTION[hunkActions.kind ?? 'undo']
              return (
                <tr key={row.key} className="group bg-surface" data-hunk={row.key}>
                  <td colSpan={cols} className="py-0 pl-3 pr-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <div
                        className={cn('min-w-0 flex-1 py-0.5', headerText, viewed ? 'text-tertiary' : 'text-muted')}
                        title={row.header}
                      >
                        {row.header}
                      </div>
                      {/* Pinned to the visible right edge while a long unified line scrolls sideways. */}
                      <span className="sticky right-0 flex shrink-0 items-center gap-1 bg-surface pl-1 font-sans">
                        <span className={cn('flex', REVEAL)}>
                          <IconButton
                            icon={action.icon}
                            label={`${action.verb} the hunk at line ${at}`}
                            title={hunkActions.blockedReason ?? action.title}
                            size="xs"
                            tone="onSurface"
                            disabled={Boolean(hunkActions.busy || hunkActions.blockedReason)}
                            onClick={() => hunkActions.onUndo(target)}
                          />
                        </span>
                        {hunkActions.onViewed ? (
                          <span className={viewed ? 'flex' : cn('flex', REVEAL)}>
                            <IconButton
                              icon="check"
                              label={`Mark the hunk at line ${at} viewed`}
                              title={viewed ? 'Viewed — mark as not viewed' : 'Mark this hunk viewed'}
                              size="xs"
                              tone="onSurface"
                              active={viewed}
                              aria-pressed={viewed}
                              onClick={() => hunkActions.onViewed?.(target, !viewed)}
                            />
                          </span>
                        ) : null}
                      </span>
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
                <tr className={added ? undefined : ROW_BG[line.kind]} data-diff-line={line.kind}>
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
                        from={asking.target.lines ? lineLabel(asking.target.lines[0]!) : undefined}
                        before={asking.target.side === 'old' && asking.target.line.kind !== 'ctx'}
                        onClose={() => setAsking(null)}
                        onSend={(question) => {
                          onAsk(asking.target, question)
                          setSent(row.key)
                          setAsking(null)
                        }}
                        onQueue={
                          onQueue
                            ? (comment) => {
                                onQueue(asking.target, comment)
                                setAsking(null)
                              }
                            : undefined
                        }
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
        <p className="m-0 px-3 py-2 font-sans text-xs text-muted" data-review-cut>
          {/* What the cut leaves out that matters is the changed lines; a cut
              into the last few lines of context leaves out nothing changed. */}
          {hiddenChanged > 0
            ? linesLeftOut(hiddenChanged, 'more', 'changed')
            : `Only the first ${parsed.flat.length} lines are shown.`}
        </p>
      ) : null}
    </>
  )
}

function AskLine({
  n,
  from,
  before,
  onSend,
  onQueue,
  onClose
}: {
  n: number
  /** The range's first line, when the question covers several. */
  from?: number
  before: boolean
  onSend: (question: string) => void
  /** Add to the review instead of sending (Ctrl/Cmd+Enter, or the button). */
  onQueue?: (comment: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // A line was just picked to ask about; the question goes here.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const text = value.trim()
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && text) {
      event.preventDefault()
      // Enter sends now, as it always has; Ctrl/Cmd+Enter adds it to the review.
      if (onQueue && (event.ctrlKey || event.metaKey)) onQueue(text)
      else onSend(text)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }
  const label = from != null ? `L${from}–${n}` : `L${n}`
  return (
    <div className="my-2 flex items-start gap-2.5 border-y border-border bg-bg px-4 py-2 font-sans text-sm" data-ask-line>
      <span className="pt-0.5 font-mono text-caption text-tertiary">{label}</span>
      <span className="pt-0.5 font-mono text-accent" aria-hidden>
        ›
      </span>
      <textarea
        ref={inputRef}
        value={value}
        rows={Math.min(6, Math.max(1, value.split('\n').length))}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!text) onClose()
        }}
        className="min-w-0 flex-1 resize-none rounded-sm bg-transparent text-sm leading-5 text-fg outline-none placeholder:text-tertiary focus-visible:vy-focus-ring"
        placeholder={
          onQueue
            ? 'Ask or change this — Enter sends it now, Ctrl+Enter adds it to a review, Shift+Enter for a new line'
            : 'Ask about or change this line — goes to the agent as a follow-up'
        }
        aria-label={`Ask the agent about ${from != null ? `lines ${from} to ${n}` : `line ${n}`}${before ? ' before the change' : ''}`}
      />
      {onQueue && text ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onQueue(text)}
          >
            Add to review
          </button>
          <button
            type="button"
            className="rounded-sm px-1.5 py-0.5 text-xs text-accent hover:text-fg focus-visible:vy-focus-ring"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSend(text)}
          >
            Send now
          </button>
        </span>
      ) : null}
    </div>
  )
}
