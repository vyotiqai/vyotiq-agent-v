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
      <Icon name="trash" size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0">
        {hasAdditionalMessage ? <p className="m-0 text-fg/80">{data.message}</p> : null}
        {data.recursive ? (
          <p className="m-0 mt-1 text-tertiary">Recursive delete</p>
        ) : null}
      </div>
    </div>
  )
}
