import { useMemo } from 'react'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseGlobData } from '../parsers/glob'
import { Chip, PathList, TruncatedBanner } from '../primitives'

export function GlobBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseGlobData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {!inGroup ? <Chip>{data.pattern}</Chip> : null}
        <span className="text-2xs tabular-nums text-tertiary">
          {data.paths.length}{' '}
          {data.nested
            ? data.paths.length === 1
              ? 'nested match'
              : 'nested matches'
            : data.paths.length === 1
              ? 'file'
              : 'files'}
          {data.truncated ? ' (truncated)' : ''}
        </span>
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <PathList paths={data.paths} />
    </div>
  )
}
