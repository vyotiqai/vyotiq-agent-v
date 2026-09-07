import type { UiItem, UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import type { DiffLine } from '../toolUi'
import {
  parseDiffPreview,
  parseEditCardData,
  parseDeleteData,
  collectWritingChanges
} from '../toolUi'
import type { ChangedFile, ToolItem, TranscriptRow } from './transcriptRows'

export const WRITING_TOOLS = new Set(['edit', 'str_replace', 'delete'])

export function mergeChangedFileAction(
  existing?: 'created' | 'modified' | 'deleted',
  incoming?: 'created' | 'modified' | 'deleted'
): 'created' | 'modified' | 'deleted' | undefined {
  if (incoming === 'deleted') return 'deleted'
  if (existing === 'deleted') return incoming === 'created' ? 'created' : 'deleted'
  if (existing === 'created' || incoming === 'created') return 'created'
  if (existing === 'modified' || incoming === 'modified') return 'modified'
  return undefined
}

export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

export type CheckpointChangedFile = {
  path: string
  action: 'created' | 'modified' | 'deleted'
}

/** Merge writes_checkpoint paths into tool-arg changed files (terminal/MCP writes). */
export function mergeCheckpointChangedFiles(
  toolFiles: ChangedFile[],
  checkpointFiles: readonly CheckpointChangedFile[] | null | undefined
): ChangedFile[] {
  if (!checkpointFiles?.length) return toolFiles
  const map = new Map<string, ChangedFile>()
  for (const file of toolFiles) {
    const key = normalizeRelPath(file.path)
    map.set(key, { ...file, path: key })
  }
  for (const cp of checkpointFiles) {
    const key = normalizeRelPath(cp.path)
    const existing = map.get(key)
    if (existing) {
      existing.action = mergeChangedFileAction(existing.action, cp.action)
      if (!existing.action) delete existing.action
      continue
    }
    // No tool-arg diff exists for this path — do not invent line counts.
    map.set(key, { path: key, action: cp.action })
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Checkpoint paths with no matching writing-tool row in the same scope. */
export function checkpointOnlyChangedFiles(
  toolFiles: ChangedFile[],
  checkpointFiles: readonly CheckpointChangedFile[] | null | undefined
): ChangedFile[] {
  if (!checkpointFiles?.length) return []
  const toolPaths = new Set(toolFiles.map((f) => normalizeRelPath(f.path)))
  return checkpointFiles
    .filter((cp) => !toolPaths.has(normalizeRelPath(cp.path)))
    .map((cp) => {
      const key = normalizeRelPath(cp.path)
      // No tool-arg diff exists for this path — do not invent line counts.
      return { path: key, action: cp.action }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function isToolItem(item: UiItem): item is ToolItem {
  return item.kind === 'tool'
}

function appendLines(
  map: Map<string, DiffLine[]>,
  path: string,
  lines: DiffLine[]
): void {
  if (!path || lines.length === 0) return
  const key = normalizeRelPath(path)
  const existing = map.get(key)
  if (!existing) {
    map.set(key, lines)
    return
  }
  existing.push({ kind: 'gap', text: '', lineNumber: null }, ...lines)
}

export function diffLinesByPath(tool: UiToolRow): Map<string, DiffLine[]> {
  const out = new Map<string, DiffLine[]>()
  if (!WRITING_TOOLS.has(tool.name)) return out

  if (tool.name === 'delete') {
    const args = parseArgsRecord(tool.argsPreview)
    const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
    if (path) out.set(normalizeRelPath(path), [])
    return out
  }

  const { path } = parseEditCardData(tool)
  appendLines(out, path, parseDiffPreview(tool))
  return out
}

function mergeToolDiffs(
  target: Map<string, DiffLine[]>,
  source: Map<string, DiffLine[]>
): void {
  for (const [path, lines] of source) {
    appendLines(target, path, lines)
  }
}

/** Per-turn, per-path diff lines from writing tool args (for ChangeSummary expand). */
export function collectTurnFileDiffs(
  rows: readonly TranscriptRow[]
): Map<number, Map<string, DiffLine[]>> {
  const byTurn = new Map<number, Map<string, DiffLine[]>>()

  const ensure = (turnIndex: number): Map<string, DiffLine[]> => {
    let map = byTurn.get(turnIndex)
    if (!map) {
      map = new Map()
      byTurn.set(turnIndex, map)
    }
    return map
  }

  for (const row of rows) {
    if (row.kind === 'card') {
      if (row.item.tool.status !== 'done') continue
      mergeToolDiffs(ensure(row.turnIndex), diffLinesByPath(row.item.tool))
    } else if (row.kind === 'activity') {
      for (const toolItem of row.tools) {
        if (toolItem.tool.status !== 'done') continue
        mergeToolDiffs(ensure(row.turnIndex), diffLinesByPath(toolItem.tool))
      }
    }
  }

  return byTurn
}

/** Session-wide file diffs from writing tools (Changes panel). */
export function collectSessionFileDiffs(items: UiItem[]): Map<string, DiffLine[]> {
  const out = new Map<string, DiffLine[]>()
  for (const item of items) {
    if (!isToolItem(item) || item.tool.status !== 'done') continue
    mergeToolDiffs(out, diffLinesByPath(item.tool))
  }
  return out
}

/** Session-wide changed files with +/- counts (Changes panel). */
export function collectSessionChangedFiles(items: UiItem[]): ChangedFile[] {
  const totals = new Map<string, ChangedFile>()
  for (const item of items) {
    if (!isToolItem(item) || item.tool.status !== 'done') continue
    if (item.tool.name === 'delete') {
      const { path } = parseDeleteData(item.tool)
      if (!path) continue
      const key = normalizeRelPath(path)
      const existing = totals.get(key)
      if (existing) {
        existing.removed = (existing.removed ?? 0) + 1
        existing.action = mergeChangedFileAction(existing.action, 'deleted')
        if (!existing.action) delete existing.action
      } else {
        totals.set(key, { path: key, added: 0, removed: 1, action: 'deleted' })
      }
      continue
    }
    if (item.tool.name !== 'edit' && item.tool.name !== 'str_replace') continue
    for (const change of collectWritingChanges(item.tool)) {
      const key = normalizeRelPath(change.path)
      const existing = totals.get(key)
      if (existing) {
        existing.added = (existing.added ?? 0) + change.added
        existing.removed = (existing.removed ?? 0) + change.removed
        existing.action = mergeChangedFileAction(existing.action, change.action)
        if (!existing.action) delete existing.action
      } else {
        totals.set(key, {
          path: key,
          added: change.added,
          removed: change.removed,
          ...(change.action ? { action: change.action } : {})
        })
      }
    }
  }
  return [...totals.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Items belonging to the latest user turn (from last user message through end). */
export function sliceLastUserTurn(items: UiItem[]): UiItem[] {
  let lastUserIdx = -1
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'message' && item.role === 'user') lastUserIdx = i
  }
  return lastUserIdx >= 0 ? items.slice(lastUserIdx) : items
}

/** Changed files for the last agent turn only (“Last Agent Turn” scope). */
export function collectLastTurnChangedFiles(items: UiItem[]): ChangedFile[] {
  return collectSessionChangedFiles(sliceLastUserTurn(items))
}

/** File diffs for the last agent turn only. */
export function collectLastTurnFileDiffs(items: UiItem[]): Map<string, DiffLine[]> {
  return collectSessionFileDiffs(sliceLastUserTurn(items))
}
