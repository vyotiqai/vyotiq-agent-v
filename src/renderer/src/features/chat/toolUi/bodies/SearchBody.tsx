import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseSearchData } from '../parsers/search'
import { Chip, TruncatedBanner } from '../primitives'
import { useRunSession } from '../../RunSessionContext'

export function SearchBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const { onOpenWorkspaceFile } = useRunSession()
  const data = useMemo(() => parseSearchData(tool), [tool])
  const filenameHits = data.hits.filter((h) => h.isFilenameHit)
  const contentHits = data.hits.filter((h) => !h.isFilenameHit)

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {!inGroup ? <Chip>{data.query}</Chip> : null}
        <span className="text-2xs tabular-nums text-tertiary">
          {data.hits.length} {data.hits.length === 1 ? 'hit' : 'hits'}
          {data.truncated ? ' (truncated)' : ''}
        </span>
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} space-y-2`}>
        {filenameHits.length > 0 ? (
          <section>
            <h4 className="m-0 mb-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
              Files
            </h4>
            <ul className="m-0 list-none p-0">
              {filenameHits.map((hit) => (
                <li key={hit.file} className="truncate font-mono text-caption text-fg/80">
                  {onOpenWorkspaceFile ? (
                    <button
                      type="button"
                      className="min-w-0 truncate text-left underline-offset-2 hover:underline"
                      title={hit.file}
                      onClick={() => onOpenWorkspaceFile(hit.file)}
                    >
                      {hit.file}
                    </button>
                  ) : (
                    hit.file
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {contentHits.length > 0 ? (
          <section>
            <h4 className="m-0 mb-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
              Content
            </h4>
            {contentHits.map((hit) => (
              <div key={`${hit.file}:${hit.line}`} className="mb-1 font-mono text-caption">
                {onOpenWorkspaceFile && hit.line != null ? (
                  <button
                    type="button"
                    className="truncate text-tertiary underline-offset-2 hover:underline"
                    title={`${hit.file}:${hit.line}`}
                    onClick={() =>
                      onOpenWorkspaceFile(hit.file, { line: hit.line ?? undefined })
                    }
                  >
                    {hit.file}:{hit.line}
                  </button>
                ) : (
                  <div className="truncate text-tertiary">
                    {hit.file}:{hit.line}
                  </div>
                )}
                <div className="whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]">
                  {hit.snippet}
                </div>
              </div>
            ))}
          </section>
        ) : null}
        {!data.hits.length ? (
          <p className="m-0 text-caption text-tertiary">No matches</p>
        ) : null}
      </div>
    </div>
  )
}
