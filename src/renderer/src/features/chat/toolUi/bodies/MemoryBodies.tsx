import { useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import {
  READ_BODY_PREVIEW_LINES,
  TOOL_BODY_CLAMP_PX,
  TOOL_BODY_INNER,
  TOOL_BODY_PAD
} from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import {
  parseMemoryListData,
  parseMemoryReadData,
  parseMemoryWriteData
} from '../parsers/memory'
import { CodeBlock, TruncatedBanner } from '../primitives'

export function MemoryListBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseMemoryListData(tool), [tool])

  return (
    <div className={`${TOOL_BODY_INNER} space-y-2 text-caption`} aria-busy={loading || undefined}>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <section>
        <h4 className="m-0 mb-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
          index.md
        </h4>
        <p className="m-0 whitespace-pre-wrap text-fg/80">{data.indexExcerpt || '(empty)'}</p>
      </section>
      <section>
        <h4 className="m-0 mb-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
          notes/
        </h4>
        {data.notes.length ? (
          <ul className="m-0 list-disc pl-4 text-fg/80">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-tertiary">(none)</p>
        )}
      </section>
      <p className="m-0 text-tertiary">state.md: {data.hasState ? 'present' : 'absent'}</p>
    </div>
  )
}

export function MemoryReadBody({ tool, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseMemoryReadData(tool), [tool])
  const totalLines = data.lines.length
  const previewLines = data.lines.slice(0, READ_BODY_PREVIEW_LINES)
  const clamped = totalLines > READ_BODY_PREVIEW_LINES

  return (
    <div>
      {!inGroup ? (
        <div className="border-b border-border px-3 py-1 font-mono text-2xs text-tertiary">
          {data.path}
        </div>
      ) : null}
      {totalLines > 0 ? (
        <div className={`${TOOL_BODY_PAD} pb-1`}>
          <span className="text-2xs tabular-nums text-tertiary">
            {totalLines} {totalLines === 1 ? 'line' : 'lines'}
            {clamped ? ` · showing ${previewLines.length}` : ''}
          </span>
        </div>
      ) : null}
      <div
        className={cn('overflow-hidden', clamped && 'mask-fade-bottom')}
        style={{ maxHeight: TOOL_BODY_CLAMP_PX }}
        data-testid="memory-read-body-clamp"
      >
        <CodeBlock lines={previewLines} />
      </div>
    </div>
  )
}

export function MemoryWriteBody({ tool, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseMemoryWriteData(tool), [tool])

  return (
    <div>
      {!inGroup ? (
        <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-1">
          <span className="truncate font-mono text-2xs text-tertiary">{data.path}</span>
          <span className="shrink-0 text-2xs tabular-nums text-tertiary">
            {data.charCount} chars
          </span>
        </div>
      ) : null}
      <CodeBlock lines={data.preview.split('\n')} />
    </div>
  )
}
