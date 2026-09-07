import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'
import {
  TOOL_FAMILY_DELETE,
  TOOL_FAMILY_TERMINAL,
  TOOL_FAMILY_TODO
} from '@renderer/lib/utils/layout'

const FAMILY_TOOLS = new Set(['todo_write', 'delete', 'terminal'])

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
    case 'todo_write':
      return (
        <div className={cn(TOOL_FAMILY_TODO)} data-tool-family="todo">
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

/**
 * Diff cards: collapsed peek (14 lines + height clamp). Do not auto-expand on
 * live/turn flags — that flips DiffPreview to the 200-line expanded cap and
 * dumps full patches into the timeline. Failures still open so the error is
 * visible without an extra click.
 */
const DIFF_COMPACT_TOOLS = new Set(['edit', 'str_replace', 'git_diff'])

export function isFileReadTool(name: string): boolean {
  return FILE_READ_TOOLS.has(name)
}

export function isDiffCompactTool(name: string): boolean {
  return DIFF_COMPACT_TOOLS.has(name)
}

/**
 * Collapsed ToolCards for reads/diffs keep a clamped peek; all other prominent
 * tools use ExpandPanel for a true fold (same path as groups / Thought).
 */
export function toolUsesPeekCollapse(name: string): boolean {
  return FILE_READ_TOOLS.has(name) || DIFF_COMPACT_TOOLS.has(name)
}

/**
 * Whether a tool body should auto-open in the transcript.
 * Running and failed tools open; finished tools collapse. File reads + diffs
 * stay compact except on fail. Task checklists live under the pinned prompt
 * / Plan Tasks — only failed `todo_write` expands inline so errors stay visible.
 */
export function toolDefaultExpanded(
  name: string,
  status: 'running' | 'done' | 'fail'
): boolean {
  // File reads stay compact — path lives in the row; body is opt-in + clamped.
  // Failures still open so the error is visible without an extra click.
  if (FILE_READ_TOOLS.has(name)) return status === 'fail'
  // Diffs: same compact default; must not expand to full patch.
  if (DIFF_COMPACT_TOOLS.has(name)) return status === 'fail'
  if (name === 'todo_write') return status === 'fail'
  return status === 'fail' || status === 'running'
}

/** Family fold defaults — matches toolDefaultExpanded. */
export function familyDefaultExpanded(name: string, status: 'running' | 'done' | 'fail'): boolean {
  return toolDefaultExpanded(name, status)
}
