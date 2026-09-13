import { useMemo } from 'react'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseDiagnosticsData } from '../parsers/diagnostics'
import { Chip, TruncatedBanner } from '../primitives'
import { basename } from '../pathUtils'

function severityClass(severity: string): string {
  switch (severity) {
    case 'error':
      return 'text-danger'
    case 'warning':
      return 'text-warning'
    default:
      return 'text-tertiary'
  }
}

export function DiagnosticsBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseDiagnosticsData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.kind ? <Chip>{data.kind}</Chip> : null}
        {data.command ? (
          <span className="min-w-0 truncate font-mono text-2xs text-tertiary" title={data.command}>
            {data.command}
          </span>
        ) : null}
        {data.issues.length > 0 ? (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.count}
            {data.truncated ? '+' : ''} {data.count === 1 ? 'issue' : 'issues'}
          </span>
        ) : null}
        {data.exit ? (
          <span className="text-2xs tabular-nums text-tertiary">exit {data.exit}</span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {data.issues.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-1.5 p-0`}>
          {data.issues.map((issue, i) => (
            <li key={`${issue.file}:${issue.line}:${issue.col}:${i}`} className="min-w-0 text-caption">
              <div className="flex min-w-0 items-center gap-2 font-mono">
                <span className={cn('shrink-0 uppercase', severityClass(issue.severity))}>
                  {issue.severity}
                </span>
                <FileTypeIcon path={issue.file} size={14} />
                <span className="min-w-0 truncate text-fg/80" title={`${issue.file}:${issue.line}`}>
                  {basename(issue.file) || issue.file}:{issue.line}:{issue.col}
                </span>
              </div>
              <div className="mt-0.5 text-fg/75 [overflow-wrap:anywhere]">{issue.message}</div>
            </li>
          ))}
        </ul>
      ) : data.rawLines.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none p-0`}>
          {data.rawLines.slice(0, 40).map((line, i) => (
            <li
              key={`${i}:${line.slice(0, 24)}`}
              className="truncate py-0.5 font-mono text-caption text-fg/80"
              title={line}
            >
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-tertiary`}>
          {data.message || 'No diagnostics'}
        </p>
      )}
    </div>
  )
}
