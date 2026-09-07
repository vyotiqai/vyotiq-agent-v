import { memo, useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import type { DiffLine } from '../toolUi'
import { useDiffHighlight, type DiffTokens } from './useDiffHighlight'

/** Enough of the change to recognise it without turning the transcript into a file. */
export const DIFF_COLLAPSED_LINES = 14
/**
 * Cap when expanded. Syntax highlight already stops at 64 lines (plain-text rows
 * beyond that are cheap DOM), so the expanded ceiling is set by layout cost —
 * 1000 lines covers real-world diffs without freezing the renderer.
 */
export const DIFF_MAX_EXPANDED_LINES = 1000

export type DiffLayout = 'unified' | 'split'

function LineText({
  line,
  tokens
}: {
  line: DiffLine
  tokens?: readonly { text: string; color?: string }[]
}) {
  if (!tokens?.length) return <>{line.text || '\u00a0'}</>

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

/**
 * Row cues: background tint + gutter sign (+/−) mark add/del — never hue alone.
 * The sign lives in the line-# gutter; compact and keyboard-free (D2/D7 kept).
 */
function DiffLines({
  lines,
  path,
  expanded,
  followEnd,
  findQuery,
  wordWrap
}: {
  lines: DiffLine[]
  path: string
  expanded?: boolean
  /** While streaming: show newest lines in the peek instead of the head. */
  followEnd?: boolean
  findQuery?: string
  wordWrap?: boolean
}) {
  const q = findQuery?.trim().toLowerCase() ?? ''
  const filtered = useMemo(() => {
    if (!q) return lines
    return lines.filter(
      (line) => line.kind === 'gap' || line.text.toLowerCase().includes(q)
    )
  }, [lines, q])

  const visible = useMemo(() => {
    const limit = expanded ? DIFF_MAX_EXPANDED_LINES : DIFF_COLLAPSED_LINES
    if (filtered.length <= limit) return filtered
    return followEnd ? filtered.slice(-limit) : filtered.slice(0, limit)
  }, [filtered, expanded, followEnd])
  const tokens: DiffTokens = useDiffHighlight(visible, path, followEnd)
  const hiddenBeforeCount = followEnd && filtered.length > visible.length
    ? filtered.length - visible.length
    : 0

  const gutterCh = useMemo(() => {
    let maxLn = 0
    let hasSign = false
    for (const line of visible) {
      if (line.lineNumber != null && line.lineNumber > maxLn) maxLn = line.lineNumber
      if (line.kind === 'add' || line.kind === 'del') hasSign = true
    }
    // +1ch reserves room for the add/del sign beside the widest line number.
    return Math.max(hasSign ? 3 : 2, String(maxLn || 0).length + (hasSign ? 1 : 0))
  }, [visible])

  if (!filtered.length) return null
  const hidden = filtered.length - visible.length
  const hiddenBefore = hiddenBeforeCount > 0

  return (
    <div
      className={cn(
        'font-mono text-caption leading-mono',
        wordWrap ? 'overflow-hidden' : 'overflow-x-auto overflow-y-hidden'
      )}
    >
      {hiddenBefore ? (
        <p className="m-0 px-2 py-1 text-2xs text-tertiary">
          {hidden} earlier {hidden === 1 ? 'line' : 'lines'}
        </p>
      ) : null}
      {visible.map((line, index) => {
        if (line.kind === 'gap') {
          return (
            <div
              key={line.rowKey ?? `gap-${hiddenBeforeCount + index}`}
              className="h-3 border-y border-border/60 bg-surface-2/40"
              aria-hidden
            />
          )
        }

        const match = q.length > 0 && line.text.toLowerCase().includes(q)

        return (
          <div
            key={line.rowKey ?? `diff-${hiddenBeforeCount + index}-${line.kind}`}
            className={cn(
              'flex min-w-0',
              line.kind === 'add' && 'diff-row-add',
              line.kind === 'del' && 'diff-row-del',
              match && 'ring-1 ring-inset ring-accent/40'
            )}
          >
            <span
              className="shrink-0 select-none pr-1 text-right tabular-nums text-2xs text-tertiary"
              style={{ width: `${gutterCh}ch`, minWidth: '2ch' }}
              aria-hidden={line.lineNumber == null}
            >
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
              {line.lineNumber ?? ''}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 py-px pl-1 pr-2 text-fg/85',
                wordWrap
                  ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
                  : 'whitespace-pre'
              )}
            >
              <LineText line={line} tokens={tokens.get(index)} />
            </span>
          </div>
        )
      })}
      {!hiddenBefore && hidden > 0 ? (
        <p className="m-0 px-2 py-1 text-2xs text-tertiary">
          {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </p>
      ) : null}
    </div>
  )
}

export const DiffPreview = memo(function DiffPreview({
  lines,
  path,
  expanded,
  followEnd,
  layout = 'unified',
  findQuery,
  wordWrap = true
}: {
  lines: DiffLine[]
  /** Used to pick a grammar for syntax colours. */
  path: string
  expanded?: boolean
  /** Prefer the newest lines when collapsed (live streaming). */
  followEnd?: boolean
  layout?: DiffLayout
  findQuery?: string
  wordWrap?: boolean
}) {
  const splitSides = useMemo(() => {
    if (layout !== 'split') return null
    return {
      left: lines.filter((l) => l.kind === 'del' || l.kind === 'context' || l.kind === 'gap'),
      right: lines.filter((l) => l.kind === 'add' || l.kind === 'context' || l.kind === 'gap')
    }
  }, [lines, layout])

  if (!lines.length) return null

  if (splitSides) {
    return (
      <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden bg-border/40">
        <div className="min-h-0 min-w-0 overflow-auto bg-bg">
          <DiffLines
            lines={splitSides.left}
            path={path}
            expanded={expanded}
            followEnd={followEnd}
            findQuery={findQuery}
            wordWrap={wordWrap}
          />
        </div>
        <div className="min-h-0 min-w-0 overflow-auto bg-bg">
          <DiffLines
            lines={splitSides.right}
            path={path}
            expanded={expanded}
            followEnd={followEnd}
            findQuery={findQuery}
            wordWrap={wordWrap}
          />
        </div>
      </div>
    )
  }

  return (
    <DiffLines
      lines={lines}
      path={path}
      expanded={expanded}
      followEnd={followEnd}
      findQuery={findQuery}
      wordWrap={wordWrap}
    />
  )
})
