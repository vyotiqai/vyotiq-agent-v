import { useMemo } from 'react'
import { TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { UiToolRow } from '@shared/transcript'
import type { ToolBodyProps } from '../types'
import { parseScreenSnipData } from '../parsers/screenSnip'
import { Chip } from '../primitives'

export function screenSnipHasBody(tool: UiToolRow): boolean {
  if (tool.status === 'fail') return Boolean(tool.content?.trim())
  const data = parseScreenSnipData(tool)
  return Boolean(data.space || data.windows.length || data.displays.length)
}

/**
 * What a snip captured. The frames themselves sit under the row, visible
 * without opening it (see ToolImageStrip); this is the measurements the agent
 * works from, and the window list when it asked for one.
 */
export function ScreenSnipBody({ tool }: ToolBodyProps) {
  const data = useMemo(() => parseScreenSnipData(tool), [tool])
  if (tool.status === 'fail') {
    return (
      <p className={`${TOOL_BODY_PAD} m-0 text-caption text-secondary [overflow-wrap:anywhere]`}>
        {tool.content}
      </p>
    )
  }
  const listed = data.windows.length > 0 || data.displays.length > 0
  return (
    <div>
      {data.space ? (
        <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
          {data.source ? (
            <span className="min-w-0 truncate text-caption text-secondary" title={data.source}>
              {data.source}
            </span>
          ) : null}
          <Chip>{data.space}</Chip>
          {data.region ? <span className="text-caption tnum text-tertiary">{data.region}</span> : null}
          {data.burst ? <span className="text-caption tnum text-tertiary">{data.burst}</span> : null}
        </div>
      ) : null}
      {listed ? (
        <ul className={`${TOOL_BODY_INNER} m-0 list-none space-y-0.5 p-0`}>
          {data.displays.map((display) => (
            <li key={`d:${display}`} className="font-mono text-caption text-tertiary">
              {display}
            </li>
          ))}
          {data.windows.map((title, i) => (
            <li
              key={`w:${i}:${title}`}
              className="min-w-0 truncate text-caption text-secondary"
              title={title}
            >
              {title}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
