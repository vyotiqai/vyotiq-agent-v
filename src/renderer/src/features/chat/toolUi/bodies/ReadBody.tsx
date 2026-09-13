import { useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import { READ_BODY_PREVIEW_LINES, TOOL_BODY_CLAMP_PX, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseReadData } from '../parsers/read'
import { CodeBlock, DirListing, TruncatedBanner } from '../primitives'

const DIR_SECTION_LABEL =
  'text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-tertiary'

export function ReadBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const failed = tool.status === 'fail'
  const data = useMemo(() => parseReadData(tool), [tool])
  const status = (tool.content ?? '').trim()

  if (failed) {
    return (
      <div>
        {status ? (
          <p
            className={cn(
              TOOL_BODY_PAD,
              'm-0 text-caption text-danger [overflow-wrap:anywhere]'
            )}
          >
            {status}
          </p>
        ) : null}
      </div>
    )
  }

  const totalLines = data.lines.length
  const previewLines = data.isDirectory
    ? data.lines
    : data.lines.slice(0, READ_BODY_PREVIEW_LINES)
  const clamped = !data.isDirectory && totalLines > READ_BODY_PREVIEW_LINES

  return (
    <div>
      {data.isDirectory ? (
        <div className={`${TOOL_BODY_PAD} pb-1`}>
          <span className={DIR_SECTION_LABEL}>Directory</span>
        </div>
      ) : totalLines > 0 ? (
        <div className={`${TOOL_BODY_PAD} pb-1`}>
          <span className="text-2xs tabular-nums text-tertiary">
            {totalLines} {totalLines === 1 ? 'line' : 'lines'}
            {clamped ? ` · showing ${previewLines.length}` : ''}
            {data.lineRange ? ` · ${data.lineRange}` : ''}
          </span>
        </div>
      ) : null}
      {tool.contentTruncated && data.isDirectory ? (
        <TruncatedBanner loading={loading} failed={loadFailed} />
      ) : null}
      {data.isDirectory ? (
        <DirListing
          basePath={data.path}
          entries={data.lines.map((line) => {
            const dir = line.match(/^\[dir\]\s+(.+)$/)
            if (dir) return { kind: 'dir' as const, name: dir[1]!, size: '' }
            const file = line.match(/^\[file\]\s+(.+)$/)
            return { kind: 'file' as const, name: file?.[1] ?? line, size: '' }
          })}
        />
      ) : (
        <div
          className={cn('overflow-hidden', clamped && 'mask-fade-bottom')}
          style={{ maxHeight: TOOL_BODY_CLAMP_PX }}
          data-testid="read-body-clamp"
        >
          <CodeBlock lines={previewLines} startLine={data.startLine} />
        </div>
      )}
    </div>
  )
}
