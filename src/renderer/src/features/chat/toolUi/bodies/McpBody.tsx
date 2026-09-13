import { useMemo } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { humanizeSnakeCase } from '@shared/utils/mcpToolMeta'
import type { ToolBodyProps } from '../types'
import { parseMcpData } from '../parsers/mcp'
import { CodeBlock, CopyButton, PathList, TruncatedBanner } from '../primitives'

function McpResultBody({
  data,
  loading,
  loadFailed,
  truncated
}: {
  data: ReturnType<typeof parseMcpData>
  loading: boolean
  loadFailed: boolean
  truncated: boolean
}) {
  const view = data.resultView
  const banner = truncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null

  if (view.kind === 'paths') {
    return (
      <div>
        {banner}
        <PathList paths={view.paths} />
      </div>
    )
  }
  if (view.kind === 'code') {
    return (
      <div>
        {banner}
        <CodeBlock lines={view.lines} />
      </div>
    )
  }
  if (view.kind === 'lines') {
    return (
      <div>
        {banner}
        <ul className={cn(TOOL_BODY_INNER, TOOL_BODY_FLOW, 'm-0 list-none p-0')}>
          {view.lines.map((line) => (
            <li key={line} className="truncate py-0.5 font-mono text-caption text-fg/80" title={line}>
              {line}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className={TOOL_BODY_INNER}>
      {banner}
      <div className="flex items-start gap-1">
        <pre
          className={cn(
            'm-0 min-w-0 flex-1 overflow-visible rounded-sm border border-border bg-surface px-2 py-1 pr-5 font-mono text-caption whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]',
            data.isError && 'text-danger'
          )}
        >
          {view.text || '(empty)'}
        </pre>
        {view.text ? <CopyButton text={view.text} className="mt-1 shrink-0" /> : null}
      </div>
    </div>
  )
}

export function McpBody({ tool, loading, loadFailed, mcpServerNames }: ToolBodyProps) {
  const data = useMemo(
    () => parseMcpData(tool, mcpServerNames),
    [tool, mcpServerNames]
  )
  const showServerChip = data.serverName !== data.serverId
  const argChips = useMemo(() => {
    if (!data.args) return [] as string[]
    return Object.entries(data.args)
      .slice(0, 4)
      .map(([key, value]) => {
        const raw =
          typeof value === 'string'
            ? value
            : value == null
              ? ''
              : JSON.stringify(value)
        const clipped = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
        return `${key}=${clipped}`
      })
  }, [data.args])

  return (
    <div className="flex flex-col gap-2">
      <div className={`${TOOL_BODY_INNER} flex flex-wrap items-center gap-2`}>
        {showServerChip ? (
          <span className="rounded-sm border border-border bg-surface-2/60 px-1.5 py-px text-2xs text-tertiary">
            {data.serverName}
          </span>
        ) : null}
        <span className="font-medium text-caption text-fg">{humanizeSnakeCase(data.toolName)}</span>
        {data.isError ? (
          <span className="text-2xs font-medium text-danger">Error</span>
        ) : null}
      </div>
      {argChips.length > 0 ? (
        <div className={`${TOOL_BODY_INNER} flex flex-wrap gap-1`}>
          {argChips.map((chip) => (
            <span
              key={chip}
              className="max-w-full truncate rounded-sm border border-border bg-surface px-1.5 py-px font-mono text-2xs text-tertiary"
              title={chip}
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}
      <McpResultBody
        data={data}
        loading={loading ?? false}
        loadFailed={loadFailed ?? false}
        truncated={tool.contentTruncated === true}
      />
    </div>
  )
}

/** Last-resort body for unknown tool names — content only, never argsPreview. */
export function FallbackBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const content = (tool.content ?? '').trim()
  return (
    <div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      {content ? (
        <p
          className={`${TOOL_BODY_PAD} m-0 ${TOOL_BODY_FLOW} text-caption leading-relaxed whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]`}
          aria-busy={loading || undefined}
        >
          {content}
        </p>
      ) : loading ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-tertiary`}>Working…</p>
      ) : null}
    </div>
  )
}
