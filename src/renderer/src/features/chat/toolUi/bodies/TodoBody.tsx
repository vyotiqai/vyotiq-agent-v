import { useMemo } from 'react'
import { TOOL_BODY_INNER } from '@renderer/lib/utils/layout'
import { TodoChecklist } from '../../components/TodoChecklist'
import type { ToolBodyProps } from '../types'
import { parseTodoData } from '../parsers/todo'

export function TodoBody({ tool }: ToolBodyProps) {
  const data = useMemo(() => parseTodoData(tool), [tool])

  return <TodoChecklist items={data.items} className={TOOL_BODY_INNER} />
}
