import { useEffect, useRef, useState } from 'react'
import type { UiItem } from '@shared/transcript'
import { extractPartialEditArgs } from '@shared/utils/partialJson'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
import type { ChatItemsStore } from '@renderer/features/chat/chatStores'
import { collectWritingChanges, parseDeleteData } from '@renderer/features/chat/toolUi'
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

/** A read call's path, when it settled and named one. */
function readPath(item: UiItem): string | null {
  if (item.kind !== 'tool' || item.tool.name !== 'read' || item.tool.status !== 'done') return null
  const args = extractPartialEditArgs(item.tool.argsPreview) as Record<string, unknown> | null
  const path = typeof args?.path === 'string' ? args.path.trim() : ''
  return path || null
}

/**
 * The files this task read or edited, the last one it touched first. A file
 * it deleted is left out — there is nothing left to attach.
 */
export function collectTaskRecentFiles(
  items: readonly UiItem[],
  workspacePath: string | null,
  limit = 3
): string[] {
  const touched = new Map<string, number>()
  const touch = (path: string, at: number): void => {
    const key = markKey(workspacePath, path)
    touched.delete(key)
    touched.set(key, at)
  }
  items.forEach((item, at) => {
    const read = readPath(item)
    if (read) return touch(read, at)
    if (item.kind !== 'tool' || item.tool.status !== 'done') return
    if (item.tool.name === 'delete') {
      const { path } = parseDeleteData(item.tool)
      if (path) touched.delete(markKey(workspacePath, path))
      return
    }
    if (item.tool.name !== 'edit' && item.tool.name !== 'str_replace') return
    for (const change of collectWritingChanges(item.tool)) {
      if (change.action === 'deleted') touched.delete(markKey(workspacePath, change.path))
      else touch(change.path, at)
    }
  })
  return [...touched.keys()].reverse().slice(0, limit)
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
 * A value read from this task's tool calls, recomputed only when a call
 * appears, settles or grows its arguments — never per streamed token.
 * `compute` and `same` must be module-level, so they never change.
 */
function useToolDerived<T>(
  items: UiItem[],
  itemsStore: ChatItemsStore | undefined,
  workspacePath: string | null,
  initial: T,
  compute: (items: readonly UiItem[], workspacePath: string | null) => T,
  same: (a: T, b: T) => boolean
): T {
  const [value, setValue] = useState<T>(initial)
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
      const computed = compute(list, workspacePath)
      setValue((prev) => (same(prev, computed) ? prev : computed))
    }
    scan()
    const unsubscribe = itemsStore?.subscribeItems(scan)
    return () => {
      unsubscribe?.()
    }
  }, [itemsStore, fallbackItems, workspacePath, compute, same])

  return value
}

/** This task's footprint on the workspace's files, for the Files tab: what it edited and what it read. */
export function useAgentFileMarks(
  items: UiItem[],
  itemsStore: ChatItemsStore | undefined,
  workspacePath: string | null
): AgentFileMarks {
  return useToolDerived(items, itemsStore, workspacePath, NO_MARKS, collectAgentFileMarks, sameMarks)
}

const NO_FILES: readonly string[] = []

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i])
}

function recentFiles(items: readonly UiItem[], workspacePath: string | null): readonly string[] {
  return collectTaskRecentFiles(items, workspacePath)
}

/** The files this task touched last, for the @ menu's Recent files. */
export function useTaskRecentFiles(
  items: UiItem[],
  itemsStore: ChatItemsStore | undefined,
  workspacePath: string | null
): readonly string[] {
  return useToolDerived(items, itemsStore, workspacePath, NO_FILES, recentFiles, sameFiles)
}
