import { useSyncExternalStore } from 'react'
import { SCREEN_DO_ACTIONS, TASK_VIEW_SOURCES } from '@shared/viewSources'
import type { ViewBlock, ViewSpec } from '@shared/viewSpec'
import { workspacePathsEqual } from '@shared/workspacePathMatch'

/*
  Views you pinned to Home from a task. A pinned view keeps its layout, not
  its data: only its live blocks (and the app buttons beside them) are kept,
  and every figure is read again each time it opens. So a pinned view is
  never stale and opening one costs no model call. Kept in this window's
  storage, like the pane layout: losing it loses a shortcut, never work.
  Home holds PINNED_SCREENS_MAX of them; a pin past that is refused, never
  made room for by dropping one you chose.
*/

export type PinnedScreen = {
  id: string
  workspacePath: string
  /** The task whose answer it came from, to go back to. */
  runId?: string
  /** The view's own id: pinning the same view of the same task again replaces it. */
  viewId: string
  /** The JSON of the pinnable spec. */
  spec: string
  /** What Home calls it: the view's title, or the name you gave it. */
  title: string
  pinnedAt: string
  /** You named it; a new layout of the same view keeps that name. */
  renamed?: true
}

const KEY = 'vyotiq.screens.pinned.v2'
/** A Home section, not an archive. */
export const PINNED_SCREENS_MAX = 12

const PINNABLE_BLOCKS: ReadonlySet<ViewBlock['type']> = new Set(['live', 'actions'])

/**
 * The part of a view worth keeping on Home: the blocks the app fills itself,
 * with the app buttons beside them. Anything the model wrote — figures, and
 * notes, which carry figures as often as not ("3 files changed") — was true
 * when it wrote it and would go stale on a page that says every value is
 * read live. A task's own source has no task there to read; a `say` button
 * has no task to speak to. Null when no live block is left — such a view is
 * an answer, not something to come back to.
 */
export function pinnableView(spec: ViewSpec): ViewSpec | null {
  const blocks: ViewBlock[] = []
  for (const b of spec.blocks) {
    if (!PINNABLE_BLOCKS.has(b.type)) continue
    if (b.type === 'live' && TASK_VIEW_SOURCES.has(b.source)) continue
    if (b.type === 'actions') {
      const acts = b.actions.filter((a) => a.do && SCREEN_DO_ACTIONS.includes(a.do.action)).map(({ say: _say, ...a }) => a)
      if (acts.length > 0) blocks.push({ ...b, actions: acts })
      continue
    }
    blocks.push(b)
  }
  return blocks.some((b) => b.type === 'live') ? { ...spec, blocks } : null
}

const listeners = new Set<() => void>()
let cache: PinnedScreen[] | null = null

function isPinned(v: unknown): v is PinnedScreen {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return ['id', 'workspacePath', 'viewId', 'spec', 'title', 'pinnedAt'].every((k) => typeof p[k] === 'string') && (p.runId === undefined || typeof p.runId === 'string')
}

function read(): PinnedScreen[] {
  if (cache) return cache
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    cache = Array.isArray(parsed) ? parsed.filter(isPinned).slice(0, PINNED_SCREENS_MAX) : []
  } catch {
    cache = []
  }
  return cache
}

function write(next: PinnedScreen[]): void {
  cache = next.slice(0, PINNED_SCREENS_MAX)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // Storage full or blocked: the pin lasts for this session only.
  }
  for (const l of listeners) l()
}

export function pinnedScreens(): readonly PinnedScreen[] {
  return read()
}

export function usePinnedScreens(): readonly PinnedScreen[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    read,
    () => []
  )
}

/** Which view a pin is: the same id in another task is another view ("changes" is a common id). */
export type PinKey = { workspacePath: string; runId?: string | null; viewId: string }

const sameView = (p: PinnedScreen, key: PinKey): boolean =>
  workspacePathsEqual(p.workspacePath, key.workspacePath) && p.viewId === key.viewId && (p.runId ?? null) === (key.runId ?? null)

export type PinResult = { ok: true; pinned: PinnedScreen } | { ok: false; reason: 'full' }

let lastId = ''
function newId(): string {
  let id = `screen-${Date.now().toString(36)}`
  // Two pins in one millisecond (a test, a double click) still get their own ids.
  if (id <= lastId) id = `${lastId}x`
  lastId = id
  return id
}

/**
 * Newest first. Pinning the same view of the same task again replaces it, on
 * its newest layout and in its place; a new one past the limit is refused.
 */
export function pinScreen(screen: Omit<PinnedScreen, 'id' | 'pinnedAt'>): PinResult {
  const list = read()
  const at = list.findIndex((p) => sameView(p, screen))
  if (at < 0 && list.length >= PINNED_SCREENS_MAX) return { ok: false, reason: 'full' }
  const was = at >= 0 ? list[at]! : null
  // A name you gave it outlives a new layout.
  const pinned: PinnedScreen = { ...screen, ...(was?.renamed ? { title: was.title, renamed: true } : {}), id: newId(), pinnedAt: new Date().toISOString() }
  write(was ? list.map((p, i) => (i === at ? pinned : p)) : [pinned, ...list])
  return { ok: true, pinned }
}

export function unpinScreen(id: string): void {
  write(read().filter((p) => p.id !== id))
}

export function findPinned(key: PinKey): PinnedScreen | null {
  return read().find((p) => sameView(p, key)) ?? null
}

/** Call a pin something else; an empty name goes back to the view's own title. */
export function renameScreen(id: string, title: string, viewTitle?: string): void {
  const name = title.trim().slice(0, 80)
  write(read().map((p) => (p.id !== id ? p : name ? { ...p, title: name, renamed: true } : { ...p, title: viewTitle ?? p.title, renamed: undefined })))
}

/**
 * Move a pin up (-1) or down (+1) among `among` — the ones Home lists, so a
 * step never lands behind a pin from a closed workspace that isn't shown.
 */
export function moveScreen(id: string, step: -1 | 1, among?: readonly string[]): void {
  const list = [...read()]
  const visible = among ? list.filter((p) => among.includes(p.id)) : list
  const i = visible.findIndex((p) => p.id === id)
  const j = i + step
  if (i < 0 || j < 0 || j >= visible.length) return
  const a = list.indexOf(visible[i]!)
  const b = list.indexOf(visible[j]!)
  ;[list[a], list[b]] = [list[b]!, list[a]!]
  write(list)
}

/** Test hook. */
export function resetPinnedScreensForTests(): void {
  cache = null
}
