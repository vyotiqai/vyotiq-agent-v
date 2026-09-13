import { useMemo } from 'react'
import { TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseStatusMessageData } from '../parsers/status'
import { Chip } from '../primitives'

export function StatusMessageBody({ tool }: ToolBodyProps) {
  const data = useMemo(() => parseStatusMessageData(tool), [tool])

  return (
    <div>
      <div className={`${TOOL_BODY_PAD} flex flex-wrap items-center gap-2 pb-1`}>
        {data.chip ? <Chip>{data.chip}</Chip> : null}
      </div>
      {data.answers.length > 0 ? (
        <ul className={`${TOOL_BODY_INNER} m-0 list-none space-y-1 p-0`}>
          {data.answers.map((answer, i) => (
            <li key={`${i}:${answer.slice(0, 24)}`} className="text-caption text-fg/80">
              {answer}
            </li>
          ))}
        </ul>
      ) : data.message ? (
        <p className={`${TOOL_BODY_PAD} m-0 text-caption text-fg/80 [overflow-wrap:anywhere]`}>
          {data.message}
        </p>
      ) : null}
    </div>
  )
}
