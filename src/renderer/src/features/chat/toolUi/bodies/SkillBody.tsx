import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { MarkdownContent } from '@renderer/lib/ui'
import type { ToolBodyProps } from '../types'
import { parseSkillData } from '../parsers/skill'
import { PathList, TruncatedBanner } from '../primitives'

export function SkillBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseSkillData(tool), [tool])

  return (
    <div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}

      {data.kind === 'directory' ? (
        <div>
          <div className={`${TOOL_BODY_PAD} flex items-center gap-2 pb-1`}>
            <span className="truncate font-mono text-caption text-tertiary" title={data.dirPath}>
              {data.dirPath}
            </span>
            <span className="shrink-0 text-caption tnum text-tertiary">
              {data.files.length} {data.files.length === 1 ? 'file' : 'files'}
            </span>
          </div>
          <PathList paths={data.files} />
        </div>
      ) : null}

      {data.kind === 'markdown' ? (
        <div
          className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW}`}
          aria-busy={loading || undefined}
        >
          <MarkdownContent content={data.content} size="caption" tone="secondary" />
        </div>
      ) : null}

      {data.kind === 'message' && data.message ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-tertiary [overflow-wrap:anywhere]`}>
          {data.message}
        </p>
      ) : null}
    </div>
  )
}
