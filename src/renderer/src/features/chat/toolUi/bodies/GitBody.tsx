import { useMemo } from 'react'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { DiffPreview } from '../../components/DiffPreview'
import type { ToolBodyProps } from '../types'
import { parseGitCommitData, parseGitDiffData, parseGitStatusData } from '../parsers/git'
import { Chip, TruncatedBanner } from '../primitives'
import { basename } from '../pathUtils'
import { useRunSession } from '../../RunSessionContext'

export function GitStatusBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const { onOpenWorkspaceFile } = useRunSession()
  const data = useMemo(() => parseGitStatusData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.branch ? <Chip>{data.branch}</Chip> : null}
        {data.message ? (
          <span className="text-caption text-tertiary">{data.message}</span>
        ) : (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.clean
              ? 'clean'
              : `${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}`}
            {data.added > 0 ? <span className="ml-2 text-success">+{data.added}</span> : null}
            {data.removed > 0 ? <span className="ml-2 text-danger">-{data.removed}</span> : null}
          </span>
        )}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {data.files.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-1 p-0`}>
          {data.files.map((file) => (
            <li
              key={file.path}
              className="flex min-w-0 items-center gap-2 font-mono text-caption text-fg/80"
            >
              <span className="w-8 shrink-0 text-tertiary">{file.status}</span>
              <FileTypeIcon path={file.path} size={14} />
              {onOpenWorkspaceFile ? (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline"
                  title={file.path}
                  onClick={() => onOpenWorkspaceFile(file.path)}
                >
                  {basename(file.path) || file.path}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {basename(file.path) || file.path}
                </span>
              )}
              <span className="ml-auto flex shrink-0 gap-2 tabular-nums">
                {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
                {file.removed > 0 ? <span className="text-danger">-{file.removed}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function GitDiffBody({ tool, expanded, loading, loadFailed, inGroup }: ToolBodyProps) {
  const { onOpenWorkspaceFile } = useRunSession()
  const data = useMemo(() => parseGitDiffData(tool), [tool])
  const showMeta = !inGroup || data.added > 0 || data.removed > 0 || Boolean(data.path)

  return (
    <div aria-busy={loading || undefined}>
      {showMeta ? (
        <div
          className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 border-b border-border pb-2`}
        >
          {data.path ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <FileTypeIcon path={data.path} size={14} />
              {onOpenWorkspaceFile ? (
                <button
                  type="button"
                  className="min-w-0 truncate text-left font-mono text-caption text-fg/85 underline-offset-2 hover:underline"
                  title={data.path}
                  onClick={() => {
                    if (data.path) onOpenWorkspaceFile(data.path)
                  }}
                >
                  {basename(data.path) || data.path}
                </button>
              ) : (
                <span className="min-w-0 truncate font-mono text-caption text-fg/85" title={data.path}>
                  {basename(data.path) || data.path}
                </span>
              )}
            </span>
          ) : !inGroup ? (
            <Chip>{data.summary}</Chip>
          ) : null}
          {data.added > 0 ? (
            <span className="text-2xs tabular-nums text-success">+{data.added}</span>
          ) : null}
          {data.removed > 0 ? (
            <span className="text-2xs tabular-nums text-danger">-{data.removed}</span>
          ) : null}
        </div>
      ) : null}
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {data.lines.length > 0 ? (
        <DiffPreview lines={data.lines} path={data.path || 'diff'} expanded={expanded} />
      ) : (
        <pre className={`${TOOL_BODY_PAD} m-0 ${TOOL_BODY_FLOW} font-mono text-caption leading-relaxed whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]`}>
          {data.message || 'No diff'}
        </pre>
      )}
    </div>
  )
}

export function GitCommitBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseGitCommitData(tool), [tool])
  const chip = data.hash ? data.hash.slice(0, 7) : data.summary

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        <Chip>{chip}</Chip>
        {data.message ? (
          <span className="min-w-0 text-caption text-tertiary [overflow-wrap:anywhere]">
            {data.message}
          </span>
        ) : data.detail ? (
          <span className="text-caption text-tertiary">{data.detail}</span>
        ) : null}
        {data.pushed === true ? (
          <span className="text-2xs text-success">pushed</span>
        ) : data.committed === false ? (
          <span className="text-2xs text-tertiary">nothing to commit</span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
    </div>
  )
}
