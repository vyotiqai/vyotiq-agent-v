import { CHAT_COLUMN_MIN_USABLE_PX } from '@renderer/lib/utils/layout'
import { workspacePathsEqual } from '@shared/workspacePathMatch'

export const CHAT_PANE_LAYOUT_KEY = 'vyotiq.chatPaneLayout'
export const SESSION_DRAG_MIME = 'application/x-vyotiq-session'

export type SessionDragPayload = {
  workspacePath: string
  runId: string
}

export type ChatPaneSession = {
  workspacePath: string
  runId: string
}

export type ChatPane = {
  paneId: string
  workspacePath: string
  runId: string | null
}

export type ChatPaneLayout = {
  panes: ChatPane[]
  focusedPaneId: string
  /** Relative flex weights; length matches panes. */
  sizes: number[]
}

export type PaneDropZone = 'left' | 'center' | 'right'

let paneIdCounter = 0
/** Timestamp of drag start; 0 when no session drag is active. */
let sessionDragActive = 0

/**
 * A module flag alone leaks: if the sidebar row unmounts mid-drag, dragend
 * never fires and ordinary text/plain drags would keep being misread as
 * session drags. The timestamp expires so the fallback self-clears.
 */
export const SESSION_DRAG_TTL_MS = 10_000

/**
 * Set while a sidebar session row is mid-drag (Electron dragover MIME quirk:
 * dragover may only expose text/plain, not the custom MIME).
 */
export function markSessionDragStart(): void {
  sessionDragActive = Date.now()
}

export function markSessionDragEnd(): void {
  sessionDragActive = 0
}

export function isSessionDragEvent(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.types.includes(SESSION_DRAG_MIME)) return true
  return (
    sessionDragActive > 0 &&
    Date.now() - sessionDragActive < SESSION_DRAG_TTL_MS &&
    dataTransfer.types.includes('text/plain')
  )
}

export function createPaneId(): string {
  paneIdCounter += 1
  return `pane-${paneIdCounter}-${Date.now().toString(36)}`
}

export function maxPaneCount(
  viewportWidth: number,
  reservedPx = 0
): number {
  const available = Math.max(0, viewportWidth - reservedPx)
  return Math.max(1, Math.floor(available / CHAT_COLUMN_MIN_USABLE_PX))
}

export function equalSizes(count: number): number[] {
  if (count <= 0) return []
  const weight = 1 / count
  return Array.from({ length: count }, () => weight)
}

export function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, n) => sum + n, 0)
  if (total <= 0 || sizes.length === 0) return equalSizes(Math.max(1, sizes.length))
  return sizes.map((n) => n / total)
}

export function singlePaneLayout(
  workspacePath: string,
  runId: string | null,
  paneId = createPaneId()
): ChatPaneLayout {
  return {
    panes: [{ paneId, workspacePath, runId }],
    focusedPaneId: paneId,
    sizes: [1]
  }
}

export function findPane(layout: ChatPaneLayout, paneId: string): ChatPane | undefined {
  return layout.panes.find((p) => p.paneId === paneId)
}

export function focusedPane(layout: ChatPaneLayout): ChatPane | null {
  return findPane(layout, layout.focusedPaneId) ?? layout.panes[0] ?? null
}

export function visibleRunIds(layout: ChatPaneLayout): Set<string> {
  const ids = new Set<string>()
  for (const pane of layout.panes) {
    if (pane.runId) ids.add(pane.runId)
  }
  return ids
}

export function openRunIdsFromPanes(layout: ChatPaneLayout): Set<string> {
  return visibleRunIds(layout)
}

export function paneHasSession(pane: ChatPane, session: ChatPaneSession): boolean {
  return (
    workspacePathsEqual(pane.workspacePath, session.workspacePath) &&
    pane.runId !== null &&
    pane.runId === session.runId
  )
}

export function replacePaneSession(
  layout: ChatPaneLayout,
  paneId: string,
  session: ChatPaneSession
): ChatPaneLayout {
  const idx = layout.panes.findIndex((p) => p.paneId === paneId)
  if (idx < 0) return layout
  const panes = layout.panes.map((p, i) =>
    i === idx
      ? { ...p, workspacePath: session.workspacePath, runId: session.runId }
      : p
  )
  return { ...layout, panes, focusedPaneId: paneId }
}

export function focusPane(layout: ChatPaneLayout, paneId: string): ChatPaneLayout {
  if (!findPane(layout, paneId)) return layout
  return { ...layout, focusedPaneId: paneId }
}

export function closePane(layout: ChatPaneLayout, paneId: string): ChatPaneLayout {
  if (layout.panes.length <= 1) return layout
  const idx = layout.panes.findIndex((p) => p.paneId === paneId)
  if (idx < 0) return layout
  const panes = layout.panes.filter((p) => p.paneId !== paneId)
  const sizes = normalizeSizes(layout.sizes.filter((_, i) => i !== idx))
  let focusedPaneId = layout.focusedPaneId
  if (focusedPaneId === paneId) {
    const nextIdx = Math.min(idx, panes.length - 1)
    focusedPaneId = panes[nextIdx]?.paneId ?? panes[0]!.paneId
  }
  return { panes, focusedPaneId, sizes }
}

export function insertPaneBeside(
  layout: ChatPaneLayout,
  anchorPaneId: string,
  side: 'left' | 'right',
  session: ChatPaneSession,
  maxPanes: number
): ChatPaneLayout | null {
  if (maxPanes <= 0) return null
  const anchorIdx = layout.panes.findIndex((p) => p.paneId === anchorPaneId)
  if (anchorIdx < 0) return null

  const existingIdx = layout.panes.findIndex((p) => paneHasSession(p, session))
  if (existingIdx >= 0) {
    return focusPane(layout, layout.panes[existingIdx]!.paneId)
  }

  if (layout.panes.length >= maxPanes) return null

  const paneId = createPaneId()
  const newPane: ChatPane = {
    paneId,
    workspacePath: session.workspacePath,
    runId: session.runId
  }
  const insertAt = side === 'left' ? anchorIdx : anchorIdx + 1
  const panes = [
    ...layout.panes.slice(0, insertAt),
    newPane,
    ...layout.panes.slice(insertAt)
  ]
  const sizes = normalizeSizes([
    ...layout.sizes.slice(0, insertAt),
    1,
    ...layout.sizes.slice(insertAt)
  ])
  return { panes, focusedPaneId: paneId, sizes }
}

export function openRunInFocusedPane(
  layout: ChatPaneLayout,
  session: ChatPaneSession
): ChatPaneLayout {
  const focused = focusedPane(layout)
  if (!focused) {
    return singlePaneLayout(session.workspacePath, session.runId)
  }
  const existingIdx = layout.panes.findIndex((p) => paneHasSession(p, session))
  if (existingIdx >= 0) {
    return focusPane(layout, layout.panes[existingIdx]!.paneId)
  }
  return replacePaneSession(layout, focused.paneId, session)
}

export function applyPaneDrop(
  layout: ChatPaneLayout,
  anchorPaneId: string,
  zone: PaneDropZone,
  session: ChatPaneSession,
  maxPanes: number
): ChatPaneLayout | null {
  if (zone === 'center') {
    const existingIdx = layout.panes.findIndex((p) => paneHasSession(p, session))
    if (existingIdx >= 0) {
      return focusPane(layout, layout.panes[existingIdx]!.paneId)
    }
    return replacePaneSession(layout, anchorPaneId, session)
  }
  const side = zone === 'left' ? 'left' : 'right'
  return insertPaneBeside(layout, anchorPaneId, side, session, maxPanes)
}

/** Drop panes whose workspace is no longer open; clamp to capacity. */
export function sanitizePaneLayout(
  layout: ChatPaneLayout,
  openWorkspacePaths: readonly string[],
  maxPanes: number
): ChatPaneLayout | null {
  const open = layout.panes.filter((pane) =>
    openWorkspacePaths.some((path) => workspacePathsEqual(path, pane.workspacePath))
  )
  if (open.length === 0) return null

  let panes = open
  if (panes.length > maxPanes) {
    const focusedId = panes.some((p) => p.paneId === layout.focusedPaneId)
      ? layout.focusedPaneId
      : panes[0]!.paneId
    const keepIds = new Set<string>([focusedId])
    for (const pane of panes) {
      if (keepIds.size >= maxPanes) break
      if (!keepIds.has(pane.paneId)) keepIds.add(pane.paneId)
    }
    panes = panes.filter((p) => keepIds.has(p.paneId))
  }

  const sizes =
    layout.sizes.length === layout.panes.length
      ? normalizeSizes(
          panes.map((pane) => {
            const idx = layout.panes.findIndex((p) => p.paneId === pane.paneId)
            return layout.sizes[idx] ?? 1
          })
        )
      : equalSizes(panes.length)
  const focusedPaneId = panes.some((p) => p.paneId === layout.focusedPaneId)
    ? layout.focusedPaneId
    : panes[0]!.paneId
  return { panes, focusedPaneId, sizes }
}

/** Remove every pane showing this session; collapse sizes/focus. */
export function removeSessionFromLayout(
  layout: ChatPaneLayout,
  session: ChatPaneSession
): ChatPaneLayout {
  let next = layout
  for (const pane of layout.panes) {
    if (!paneHasSession(pane, session)) continue
    if (next.panes.length <= 1) {
      const only = next.panes[0]!
      return {
        panes: [{ ...only, workspacePath: session.workspacePath, runId: null }],
        focusedPaneId: only.paneId,
        sizes: [1]
      }
    }
    next = closePane(next, pane.paneId)
  }
  return next
}

/**
 * Map pointer X inside a pane to a drop zone.
 * Left/right thirds open beside; middle third replaces.
 * Invalid geometry defaults to `right` so drag-open prefers split over replace.
 */
export function resolvePaneDropZone(x: number, width: number): PaneDropZone {
  if (!(width > 0) || !Number.isFinite(x)) return 'right'
  const ratio = Math.min(1, Math.max(0, x / width))
  if (ratio < 1 / 3) return 'left'
  if (ratio > 2 / 3) return 'right'
  return 'center'
}

export function setPaneSizes(layout: ChatPaneLayout, sizes: number[]): ChatPaneLayout {
  if (sizes.length !== layout.panes.length) return layout
  return { ...layout, sizes: normalizeSizes(sizes) }
}

export function syncSinglePaneSession(
  layout: ChatPaneLayout,
  workspacePath: string,
  runId: string | null
): ChatPaneLayout {
  if (layout.panes.length !== 1) return layout
  const pane = layout.panes[0]!
  if (workspacePathsEqual(pane.workspacePath, workspacePath) && pane.runId === runId) {
    return layout
  }
  return {
    ...layout,
    panes: [{ ...pane, workspacePath, runId }]
  }
}

export function replaceFocusedPaneSession(
  layout: ChatPaneLayout,
  workspacePath: string,
  runId: string | null
): ChatPaneLayout {
  const focused = focusedPane(layout)
  if (!focused) return singlePaneLayout(workspacePath, runId)
  const panes = layout.panes.map((p) =>
    p.paneId === focused.paneId ? { ...p, workspacePath, runId } : p
  )
  return { ...layout, panes, focusedPaneId: focused.paneId }
}

export type PersistedChatPaneLayout = {
  panes: Array<{ paneId: string; workspacePath: string; runId: string | null }>
  focusedPaneId: string
  sizes: number[]
}

export function serializePaneLayout(layout: ChatPaneLayout): PersistedChatPaneLayout {
  return {
    panes: layout.panes.map((p) => ({
      paneId: p.paneId,
      workspacePath: p.workspacePath,
      runId: p.runId
    })),
    focusedPaneId: layout.focusedPaneId,
    sizes: [...layout.sizes]
  }
}

export function deserializePaneLayout(raw: unknown): ChatPaneLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as PersistedChatPaneLayout
  if (!Array.isArray(data.panes) || data.panes.length === 0) return null
  if (typeof data.focusedPaneId !== 'string') return null
  const panes: ChatPane[] = []
  for (const entry of data.panes) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.paneId !== 'string') continue
    if (typeof entry.workspacePath !== 'string') continue
    const runId =
      entry.runId === null || typeof entry.runId === 'string' ? entry.runId : null
    panes.push({ paneId: entry.paneId, workspacePath: entry.workspacePath, runId })
  }
  if (panes.length === 0) return null
  const focusedPaneId = panes.some((p) => p.paneId === data.focusedPaneId)
    ? data.focusedPaneId
    : panes[0]!.paneId
  const sizes =
    Array.isArray(data.sizes) && data.sizes.length === panes.length
      ? normalizeSizes(data.sizes.map((n) => (typeof n === 'number' ? n : 1)))
      : equalSizes(panes.length)
  return { panes, focusedPaneId, sizes }
}

export function loadPaneLayoutFromStorage(): ChatPaneLayout | null {
  try {
    const raw = localStorage.getItem(CHAT_PANE_LAYOUT_KEY)
    if (!raw) return null
    return deserializePaneLayout(JSON.parse(raw))
  } catch {
    return null
  }
}

export function savePaneLayoutToStorage(layout: ChatPaneLayout): void {
  try {
    localStorage.setItem(CHAT_PANE_LAYOUT_KEY, JSON.stringify(serializePaneLayout(layout)))
  } catch {
    /* ignore quota */
  }
}

function parseSessionDragJson(raw: string): SessionDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SessionDragPayload
    if (typeof parsed.workspacePath !== 'string' || typeof parsed.runId !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function parseSessionDragPayload(dataTransfer: DataTransfer): SessionDragPayload | null {
  const custom = parseSessionDragJson(dataTransfer.getData(SESSION_DRAG_MIME))
  if (custom) return custom
  return parseSessionDragJson(dataTransfer.getData('text/plain'))
}

export function writeSessionDragPayload(
  dataTransfer: DataTransfer,
  payload: SessionDragPayload
): void {
  const raw = JSON.stringify(payload)
  dataTransfer.setData(SESSION_DRAG_MIME, raw)
  dataTransfer.setData('text/plain', raw)
  dataTransfer.effectAllowed = 'copy'
}
