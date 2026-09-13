import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { MarkdownContent } from '@renderer/lib/ui'
import type { ToolBodyProps } from '../types'
import { parseWebFetchData } from '../parsers/webFetch'
import { TruncatedBanner } from '../primitives'

export function WebFetchBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseWebFetchData(tool), [tool])

  return (
    <div>
      {!inGroup ? (
        <div className={`${TOOL_BODY_PAD} border-b border-border pb-2`}>
          <span className="truncate font-mono text-2xs text-tertiary" title={data.url}>
            {data.url}
          </span>
        </div>
      ) : null}
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} text-caption text-fg/80`}>
        <MarkdownContent content={data.content} />
      </div>
    </div>
  )
}
