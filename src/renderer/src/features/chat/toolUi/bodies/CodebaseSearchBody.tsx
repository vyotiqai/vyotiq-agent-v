import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseCodebaseSearchData } from '../parsers/codebaseSearch'
import { Chip, TruncatedBanner } from '../primitives'
import { useRunSession } from '../../RunSessionContext'

export function CodebaseSearchBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const { onOpenWorkspaceFile } = useRunSession()
  const data = useMemo(() => parseCodebaseSearchData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {!inGroup ? <Chip>{data.query}</Chip> : null}
        <span className="text-2xs tabular-nums text-tertiary">
          {data.hits.length} {data.hits.length === 1 ? 'hit' : 'hits'}
        </span>
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} space-y-2`}>
        {data.hits.map((hit) => (
          <div key={`${hit.path}:${hit.startLine}-${hit.endLine}:${hit.name}`} className="mb-1 font-mono text-caption">
            {onOpenWorkspaceFile ? (
              <button
                type="button"
                className="truncate text-tertiary underline-offset-2 hover:underline"
                title={`${hit.path}:${hit.startLine}-${hit.endLine}`}
                onClick={() => onOpenWorkspaceFile(hit.path, { line: hit.startLine })}
              >
                {hit.path}:{hit.startLine}-{hit.endLine} [{hit.kind} {hit.name}]
              </button>
            ) : (
              <div className="truncate text-tertiary">
                {hit.path}:{hit.startLine}-{hit.endLine} [{hit.kind} {hit.name}]
              </div>
            )}
            {hit.snippet ? (
              <div className="whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]">{hit.snippet}</div>
            ) : null}
          </div>
        ))}
        {!data.hits.length ? (
          <p className="m-0 text-caption text-tertiary">No codebase hits</p>
        ) : null}
      </div>
    </div>
  )
}
