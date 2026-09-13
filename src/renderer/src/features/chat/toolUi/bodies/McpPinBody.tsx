import { useMemo } from 'react'
import { TOOL_BODY_FLOW, TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseMcpPinData } from '../parsers/mcpPin'
import { Chip, TruncatedBanner } from '../primitives'

export function McpPinBody({ tool, loading, loadFailed }: ToolBodyProps) {
  const data = useMemo(() => parseMcpPinData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.filter ? <Chip>{data.filter}</Chip> : null}
        {data.pinnedCount !== null ? (
          <span className="text-2xs tabular-nums text-tertiary">{data.pinnedCount} pinned</span>
        ) : null}
        {data.releasedCount !== null ? (
          <span className="text-2xs tabular-nums text-tertiary">
            {data.releasedCount} released
          </span>
        ) : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}

      {data.message ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-tertiary [overflow-wrap:anywhere]`}>
          {data.message}
        </p>
      ) : null}

      {data.noneMessage ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-tertiary`}>{data.noneMessage}</p>
      ) : null}

      {data.sections.map((section) => (
        <div key={section.kind} className={`${TOOL_BODY_INNER} pb-1`}>
          <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
            {section.label} · {section.names.length}
          </div>
          <div className={`flex flex-wrap gap-1 ${TOOL_BODY_FLOW}`}>
            {section.names.map((name) => (
              <span
                key={name}
                className="rounded-sm border border-border bg-surface px-1.5 py-px font-mono text-2xs text-fg/80 [overflow-wrap:anywhere]"
                title={name}
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      ))}

      {data.note ? (
        <p
          className={`${TOOL_BODY_PAD} m-0 text-2xs leading-relaxed text-tertiary [overflow-wrap:anywhere]`}
        >
          {data.note}
        </p>
      ) : null}
    </div>
  )
}
