import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { parseMcpToolDisplay } from '@shared/toolSummary'
import type { ToolBodyProps } from '../types'
import {
  parseMcpIntrospectData,
  type McpListToolRow
} from '../parsers/mcpIntrospect'
import { Chip, TruncatedBanner } from '../primitives'

function groupedTools(tools: McpListToolRow[]): { serverId: string; rows: McpListToolRow[] }[] {
  const groups: { serverId: string; rows: McpListToolRow[] }[] = []
  for (const row of tools) {
    const serverId = parseMcpToolDisplay(row.name)?.serverId ?? ''
    const last = groups[groups.length - 1]
    if (last && last.serverId === serverId) last.rows.push(row)
    else groups.push({ serverId, rows: [row] })
  }
  return groups
}

function toolDisplayName(name: string): string {
  return parseMcpToolDisplay(name)?.toolName ?? name
}

export function McpIntrospectBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseMcpIntrospectData(tool), [tool])
  const groups = useMemo(
    () => (data.kind === 'tools' ? groupedTools(data.tools) : []),
    [data]
  )

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.filter ? <Chip>{data.filter}</Chip> : null}
        {data.kind === 'tools' && data.tools.length > 0 ? (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.tools.length} {data.tools.length === 1 ? 'tool' : 'tools'}
            {groups.length > 1 ? ` · ${groups.length} servers` : ''}
          </span>
        ) : null}
        {(data.kind === 'resources' || data.kind === 'prompts') && data.entries.length > 0 ? (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.entries.length} {data.entries.length === 1 ? 'entry' : 'entries'}
          </span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}

      {data.message ? (
        <p
          className={`${TOOL_BODY_PAD} m-0 whitespace-pre-wrap text-caption text-tertiary [overflow-wrap:anywhere]`}
        >
          {data.message}
        </p>
      ) : null}

      {data.kind === 'tools' && groups.length > 0 ? (
        <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} space-y-3`}>
          {groups.map((group) => (
            <div key={group.serverId || group.rows[0]?.name}>
              {group.serverId ? (
                <div className="mb-1 text-2xs font-medium text-secondary">{group.serverId}</div>
              ) : null}
              <ul className="m-0 list-none space-y-1.5 p-0">
                {group.rows.map((row) => (
                  <li key={row.name} className="min-w-0 text-caption">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className="truncate font-mono text-fg/90"
                        title={row.name}
                      >
                        {toolDisplayName(row.name)}
                      </span>
                      {row.readOnly === true ? (
                        <span className="text-2xs text-tertiary">read-only</span>
                      ) : row.readOnly === false ? (
                        <span className="text-2xs text-tertiary">write</span>
                      ) : null}
                      {row.omitted ? (
                        <span className="text-2xs text-tertiary">not in this step</span>
                      ) : null}
                    </div>
                    {row.description ? (
                      <div className="mt-0.5 text-fg/70 [overflow-wrap:anywhere]">
                        {row.description}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {(data.kind === 'resources' || data.kind === 'prompts') && data.entries.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} m-0 list-none space-y-1.5 p-0`}>
          {data.entries.map((row) => (
            <li key={`${row.serverId}:${row.label}`} className="min-w-0 text-caption">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-2xs text-tertiary">{row.serverId}</span>
                <span className="min-w-0 truncate font-mono text-fg/90" title={row.label}>
                  {row.label}
                </span>
              </div>
              {row.meta ? (
                <div className="mt-0.5 text-fg/70 [overflow-wrap:anywhere]">{row.meta}</div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {data.kind === 'resource' && data.text ? (
        <pre
          className={`${TOOL_BODY_INNER} m-0 ${TOOL_BODY_FLOW} font-mono text-caption leading-relaxed whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]`}
          aria-busy={loading || undefined}
        >
          {data.text}
        </pre>
      ) : null}

      {data.kind === 'prompt' ? (
        <div className={`${TOOL_BODY_INNER} ${TOOL_BODY_FLOW} space-y-2`}>
          {data.text ? <p className="m-0 text-caption text-fg/80">{data.text}</p> : null}
          {data.blocks.map((block, i) => (
            <div key={`${block.role}:${i}`} className="min-w-0">
              {block.role ? (
                <div className="mb-0.5 text-2xs font-medium uppercase tracking-wide text-tertiary">
                  {block.role}
                </div>
              ) : null}
              <pre className="m-0 font-mono text-caption leading-relaxed whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]">
                {block.text}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
