import { useEffect, useMemo, useState } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { DiffPreview, DIFF_COLLAPSED_LINES, DIFF_MAX_EXPANDED_LINES } from '../../components/DiffPreview'
import type { ToolBodyProps } from '../types'
import { parseDiffPreview, parseEditCardData, type DiffLine } from '../parsers/edit'
import { TruncatedBanner } from '../primitives'

/** Small growth (real token stream) snaps. A sudden dump is dripped like thinking. */
const DUMP_JUMP_LINES = 8
const REVEAL_TICK_MS = 32
const REVEAL_MAX_MS = 1600

function initialShown(lineCount: number, live: boolean): number {
  if (!live) return lineCount
  if (lineCount <= DUMP_JUMP_LINES) return lineCount
  return Math.min(2, lineCount)
}

function useLiveDiffLines(lines: DiffLine[], live: boolean): DiffLine[] {
  const target = lines.length
  const [shown, setShown] = useState(() => initialShown(target, live))

  useEffect(() => {
    if (!live) {
      setShown(target)
      return
    }

    setShown((prev) => {
      if (prev >= target) return target
      if (target - prev <= DUMP_JUMP_LINES) return target
      return prev === 0 ? Math.min(2, target) : prev
    })

    const id = window.setInterval(() => {
      setShown((prev) => {
        if (prev >= target) return target
        if (target - prev <= DUMP_JUMP_LINES) return target
        const ticks = Math.max(1, Math.floor(REVEAL_MAX_MS / REVEAL_TICK_MS))
        const step = Math.max(1, Math.ceil(target / ticks))
        return Math.min(target, prev + step)
      })
    }, REVEAL_TICK_MS)

    return () => window.clearInterval(id)
  }, [live, target])

  if (!live || shown >= target) return lines
  return lines.slice(0, Math.max(0, shown))
}

export function EditBody({ tool, expanded, loading, loadFailed }: ToolBodyProps) {
  const running = tool.status === 'running'
  const failed = tool.status === 'fail'
  const live = running && !failed
  const editData = useMemo(() => parseEditCardData(tool), [tool])
  const diffLines = useMemo(
    () =>
      parseDiffPreview(tool, {
        maxLines: expanded || live ? DIFF_MAX_EXPANDED_LINES : DIFF_COLLAPSED_LINES,
        fromEnd: live && !expanded
      }),
    [tool, expanded, live]
  )
  const painted = useLiveDiffLines(diffLines, live)
  const status = (tool.content ?? '').trim()
  const highlightPath = editData.iconPath || editData.path

  return (
    <div aria-busy={loading || running || undefined}>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {failed && status ? (
        <p
          className={cn(
            TOOL_BODY_PAD,
            'm-0 text-caption text-danger [overflow-wrap:anywhere]',
            painted.length > 0 && 'border-b border-border/50 pb-2'
          )}
        >
          {status}
        </p>
      ) : null}
      {painted.length > 0 ? (
        <>
          {failed ? (
            <p className={cn(TOOL_BODY_PAD, 'm-0 pb-1 text-2xs text-tertiary')}>Not applied</p>
          ) : null}
          <DiffPreview
            lines={painted}
            path={highlightPath}
            expanded={expanded}
            followEnd={live}
          />
        </>
      ) : !failed && status ? (
        <p
          className={cn(
            TOOL_BODY_PAD,
            'm-0 text-caption text-fg/80 [overflow-wrap:anywhere]'
          )}
        >
          {status}
        </p>
      ) : null}
    </div>
  )
}

