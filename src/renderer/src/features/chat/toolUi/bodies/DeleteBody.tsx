import { useMemo } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import type { ToolBodyProps } from '../types'
import { parseDeleteData } from '../parsers/delete'

export function DeleteBody({ tool }: ToolBodyProps) {
  const data = useMemo(() => parseDeleteData(tool), [tool])
  const defaultMessage = `Deleted ${data.path}`
  const hasAdditionalMessage = data.message !== defaultMessage

  if (!hasAdditionalMessage && !data.recursive) return null

  return (
    <div className={cn(TOOL_BODY_PAD, 'flex items-start gap-2 text-caption')}>
      {/* A delete that worked is not an alarm; the row's verb turns danger on failure. */}
      <Icon
        name="trash"
        size={14}
        className={cn('mt-px shrink-0', tool.status === 'fail' ? 'text-danger' : 'text-muted')}
      />
      <div className="min-w-0">
        {hasAdditionalMessage ? <p className="m-0 text-secondary">{data.message}</p> : null}
        {data.recursive ? (
          <p className="m-0 mt-1 text-tertiary">Recursive delete</p>
        ) : null}
      </div>
    </div>
  )
}
