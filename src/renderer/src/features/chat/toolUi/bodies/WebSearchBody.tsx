import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseWebSearchData } from '../parsers/webSearch'
import { Chip, TruncatedBanner } from '../primitives'

export function WebSearchBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseWebSearchData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {!inGroup ? <Chip>{data.query || 'web search'}</Chip> : null}
        <span className="text-2xs tabular-nums text-tertiary">
          {data.hits.length} {data.hits.length === 1 ? 'result' : 'results'}
        </span>
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} space-y-2`}>
        {data.hits.length === 0 ? (
          <p className="m-0 text-caption text-tertiary">No results</p>
        ) : (
          data.hits.map((hit) => (
            <div key={`${hit.url}:${hit.title}`} className="min-w-0">
              <div className="truncate text-caption font-medium text-fg" title={hit.title}>
                {hit.title}
              </div>
              {hit.url ? (
                <div className="truncate font-mono text-2xs text-accent" title={hit.url}>
                  {hit.url}
                </div>
              ) : null}
              {hit.snippet ? (
                <div className="mt-0.5 text-caption text-fg/75 [overflow-wrap:anywhere]">
                  {hit.snippet}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
