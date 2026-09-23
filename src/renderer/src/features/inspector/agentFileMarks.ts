import { useEffect, useRef, useState } from 'react'
import type { UiItem } from '@shared/transcript'
import { extractPartialEditArgs } from '@shared/utils/partialJson'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
import type { ChatItemsStore } from '@renderer/features/chat/chatStores'
import { collectSessionChangedFiles, normalizeRelPath } from '@renderer/features/chat/utils/turnFileDiffs'

/** What this task did to one file, from its own tool calls. */
export type AgentFileMark = {
  /** Its edits: added, modified or deleted. */
  change?: 'A' | 'M' | 'D'
  /** Its last read — with the lines, when the call named them. */
  read?: { startLine?: number; endLine?: number }
}

export type AgentFileMarks = ReadonlyMap<string, AgentFileMark>

const NO_MARKS: AgentFileMarks = new Map()

/** The only inputs the marks read: which calls exist, whether they settled, their arguments. */
function toolSignature(items: readonly UiItem[]): string {
  let signature = ''
  for (const item of items) {
    if (item.kind !== 'tool') continue
    signature += `${item.id}\u0001${item.tool.name}\u0001${item.tool.status}\u0001${item.tool.argsPreview?.length ?? 0}\u0002`
  }
  return signature
}

/** Workspace-relative, forward slashes — the tree's own path form. */
export function markKey(workspacePath: string | null, path: string): string {
  return normalizeRelPath(toWorkspaceRelPath(workspacePath, path) ?? path)
}

export function collectAgentFileMarks(items: readonly UiItem[], workspacePath: string | null): Map<string, AgentFileMark> {
  const marks = new Map<string, AgentFileMark>()
  for (const file of collectSessionChangedFiles(items as UiItem[])) {
    marks.set(markKey(workspacePath, file.path), {
      change: file.action === 'created' ? 'A' : file.action === 'deleted' ? 'D' : 'M'
    })
  }
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool.name !== 'read' || item.tool.status !== 'done') continue
    const args = extractPartialEditArgs(item.tool.argsPreview) as Record<string, unknown> | null
    const path = typeof args?.path === 'string' ? args.path.trim() : ''
    if (!path) continue
    const key = markKey(workspacePath, path)
    const read: NonNullable<AgentFileMark['read']> = {}
    if (typeof args?.startLine === 'number') read.startLine = args.startLine
    if (typeof args?.endLine === 'number') read.endLine = args.endLine
    marks.set(key, { ...marks.get(key), read })
  }
  return marks
}

function sameMarks(a: AgentFileMarks, b: AgentFileMarks): boolean {
  if (a.size !== b.size) return false
  for (const [key, mark] of a) {
    const other = b.get(key)
    if (
      !other ||
      other.change !== mark.change ||
      other.read?.startLine !== mark.read?.startLine ||
      other.read?.endLine !== mark.read?.endLine ||
      Boolean(other.read) !== Boolean(mark.read)
    ) {
      return false
    }
  }
  return true
}

/**
 * This task's footprint on the workspace's files, for the Files tab: what it
 * edited and what it read. Recomputed only when a tool call appears, settles
 * or grows its arguments — never per streamed token.
 */
export function useAgentFileMarks(
  items: UiItem[],
  itemsStore: ChatItemsStore | undefined,
  workspacePath: string | null
): AgentFileMarks {
  const [marks, setMarks] = useState<AgentFileMarks>(NO_MARKS)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const fallbackItems = itemsStore ? null : items

  useEffect(() => {
    let signature: string | null = null
    const scan = (): void => {
      const list = itemsStore?.getItems() ?? itemsRef.current
      const next = toolSignature(list)
      if (next === signature) return
      signature = next
      const computed = collectAgentFileMarks(list, workspacePath)
      setMarks((prev) => (sameMarks(prev, computed) ? prev : computed))
    }
    scan()
    const unsubscribe = itemsStore?.subscribeItems(scan)
    return () => {
      unsubscribe?.()
    }
  }, [itemsStore, fallbackItems, workspacePath])

  return marks
}
