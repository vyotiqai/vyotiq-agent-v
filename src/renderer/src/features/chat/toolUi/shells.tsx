import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_FAMILY_DELETE, TOOL_FAMILY_TERMINAL } from '@renderer/lib/utils/layout'

const FAMILY_TOOLS = new Set(['delete', 'terminal'])

/** Family body chrome for compact tools. Edit/diff use bordered ToolCard instead. */
export function wrapFamilyShell(toolName: string, children: ReactNode): ReactNode {
  if (!FAMILY_TOOLS.has(toolName)) return children

  switch (toolName) {
    case 'terminal':
      return (
        <div className={cn(TOOL_FAMILY_TERMINAL)} data-tool-family="terminal">
          {children}
        </div>
      )
    case 'delete':
      return (
        <div className={cn(TOOL_FAMILY_DELETE)} data-tool-family="delete">
          {children}
        </div>
      )
    default:
      return children
  }
}

/**
 * File-read tools dump large payloads — keep the timeline as a compact path row.
 * Failures still auto-open so the error is visible without an extra click.
 */
const FILE_READ_TOOLS = new Set(['read', 'memory_read'])

export function isFileReadTool(name: string): boolean {
  return FILE_READ_TOOLS.has(name)
}
