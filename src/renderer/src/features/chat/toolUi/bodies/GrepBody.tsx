import { useMemo } from 'react'
import type { ToolBodyProps } from '../types'
import { parseGrepData } from '../parsers/grep'
import { Chip, MatchList, TruncatedBanner } from '../primitives'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'

export function GrepBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseGrepData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {!inGroup ? <Chip>/{data.pattern}/</Chip> : null}
        <span className="text-2xs tabular-nums text-tertiary">
          {data.matchCount} {data.matchCount === 1 ? 'match' : 'matches'}
          {data.truncated ? ' (truncated)' : ''}
        </span>
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <MatchList groups={data.groups} />
    </div>
  )
}
