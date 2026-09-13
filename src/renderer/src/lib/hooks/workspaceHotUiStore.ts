import { useCallback, useSyncExternalStore } from 'react'

/**
 * Narrow external store for keystroke-hot workspace UI (composer draft + session search).
 * Keeps App/`setContexts` off the typing path while persistence still reads `contextsRef`.
 *
 * Composer drafts are keyed per run (`__draft__` when `runId` is null) so multi-pane
 * sessions on the same workspace path do not clobber each other.
 */

/** Matches `draftKeyForRun` / scroll draft key in useWorkspaceManager. */
export const HOT_COMPOSER_DRAFT_KEY = '__draft__'

export function hotComposerDraftKey(runId: string | null | undefined): string {
  return runId ?? HOT_COMPOSER_DRAFT_KEY
}

export type WorkspaceHotUi = {
  /** Legacy null-run draft; kept in sync with `composerDraftByRunId[HOT_COMPOSER_DRAFT_KEY]`. */
  composerDraft: string
  composerDraftByRunId: Record<string, string>
  sessionQuery: string
}

const EMPTY_HOT_UI: WorkspaceHotUi = Object.freeze({
  composerDraft: '',
  composerDraftByRunId: Object.freeze({}) as Record<string, string>,
  sessionQuery: ''
})

const byPath = new Map<string, WorkspaceHotUi>()
const listenersByPath = new Map<string, Set<() => void>>()
let globalRevision = 0
const globalListeners = new Set<() => void>()

function notify(path: string): void {
  globalRevision += 1
  const pathListeners = listenersByPath.get(path)
  if (pathListeners) {
    for (const listener of pathListeners) listener()
  }
  for (const listener of globalListeners) listener()
}

function cloneHot(prev: WorkspaceHotUi | undefined): WorkspaceHotUi {
  return {
    composerDraft: prev?.composerDraft ?? '',
    composerDraftByRunId: { ...(prev?.composerDraftByRunId ?? {}) },
    sessionQuery: prev?.sessionQuery ?? ''
  }
}

export function resolveHotComposerDraft(
  hot: Pick<WorkspaceHotUi, 'composerDraft' | 'composerDraftByRunId'>,
  runId: string | null | undefined
): string {
  const key = hotComposerDraftKey(runId)
  if (key in hot.composerDraftByRunId) return hot.composerDraftByRunId[key] ?? ''
  if (!runId) return hot.composerDraft
  // Match resolveComposerDraft: pre-per-run hot state with only legacy composerDraft.
  if (hot.composerDraft && Object.keys(hot.composerDraftByRunId).length === 0) {
    return hot.composerDraft
  }
  return ''
}

export function getWorkspaceHotUi(path: string | null | undefined): WorkspaceHotUi {
  if (!path) return EMPTY_HOT_UI
  return byPath.get(path) ?? EMPTY_HOT_UI
}

export function hasWorkspaceHotUi(path: string): boolean {
  return byPath.has(path)
}

export function getWorkspaceHotUiRevision(): number {
  return globalRevision
}

export function subscribeWorkspaceHotUi(
  path: string | null | undefined,
  listener: () => void
): () => void {
  if (!path) {
    globalListeners.add(listener)
    return () => {
      globalListeners.delete(listener)
    }
  }
  let set = listenersByPath.get(path)
  if (!set) {
    set = new Set()
    listenersByPath.set(path, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listenersByPath.delete(path)
  }
}

export function setWorkspaceHotUi(
  path: string,
  patch: Partial<Pick<WorkspaceHotUi, 'composerDraft' | 'sessionQuery'>> & {
    composerDraftByRunId?: Record<string, string>
  }
): WorkspaceHotUi {
  const prev = cloneHot(byPath.get(path))
  let composerDraftByRunId = prev.composerDraftByRunId
  let composerDraft = prev.composerDraft

  if (patch.composerDraftByRunId !== undefined) {
    composerDraftByRunId = { ...patch.composerDraftByRunId }
    if (HOT_COMPOSER_DRAFT_KEY in composerDraftByRunId) {
      composerDraft = composerDraftByRunId[HOT_COMPOSER_DRAFT_KEY] ?? ''
    }
  }

  if (patch.composerDraft !== undefined) {
    composerDraft = patch.composerDraft
    composerDraftByRunId = {
      ...composerDraftByRunId,
      [HOT_COMPOSER_DRAFT_KEY]: patch.composerDraft
    }
  }

  const next: WorkspaceHotUi = {
    composerDraft,
    composerDraftByRunId,
    sessionQuery:
      patch.sessionQuery !== undefined ? patch.sessionQuery : prev.sessionQuery
  }

  const sameDraftMap =
    Object.keys(next.composerDraftByRunId).length ===
      Object.keys(prev.composerDraftByRunId).length &&
    Object.entries(next.composerDraftByRunId).every(
      ([k, v]) => prev.composerDraftByRunId[k] === v
    )

  if (
    next.composerDraft === prev.composerDraft &&
    next.sessionQuery === prev.sessionQuery &&
    sameDraftMap &&
    byPath.has(path)
  ) {
    return byPath.get(path)!
  }
  byPath.set(path, next)
  notify(path)
  return next
}

/** Write the typed composer draft for a specific run (or null = new-chat draft). */
export function setWorkspaceHotComposerDraft(
  path: string,
  runId: string | null,
  draft: string
): WorkspaceHotUi {
  const prev = cloneHot(byPath.get(path))
  const key = hotComposerDraftKey(runId)
  if (prev.composerDraftByRunId[key] === draft && byPath.has(path)) {
    if (!runId && prev.composerDraft === draft) return byPath.get(path)!
    if (runId) return byPath.get(path)!
  }
  const composerDraftByRunId = { ...prev.composerDraftByRunId, [key]: draft }
  const next: WorkspaceHotUi = {
    composerDraft: runId ? prev.composerDraft : draft,
    composerDraftByRunId,
    sessionQuery: prev.sessionQuery
  }
  if (!runId) {
    next.composerDraft = draft
  }
  byPath.set(path, next)
  notify(path)
  return next
}

/** Remove one run's hot draft key (does not touch sibling runs or sessionQuery). */
export function clearWorkspaceHotComposerDraft(
  path: string,
  runId: string | null
): void {
  const prev = byPath.get(path)
  if (!prev) return
  const key = hotComposerDraftKey(runId)
  if (!(key in prev.composerDraftByRunId)) return
  const { [key]: _removed, ...composerDraftByRunId } = prev.composerDraftByRunId
  const next: WorkspaceHotUi = {
    composerDraft: key === HOT_COMPOSER_DRAFT_KEY ? '' : prev.composerDraft,
    composerDraftByRunId,
    sessionQuery: prev.sessionQuery
  }
  byPath.set(path, next)
  notify(path)
}

export function seedWorkspaceHotUi(
  path: string,
  values: {
    composerDraft?: string
    composerDraftByRunId?: Record<string, string>
    sessionQuery?: string
  }
): void {
  const prev = byPath.get(path)
  const composerDraftByRunId = {
    ...(prev?.composerDraftByRunId ?? {}),
    ...(values.composerDraftByRunId ?? {})
  }
  const composerDraft =
    values.composerDraft !== undefined
      ? values.composerDraft
      : (prev?.composerDraft ?? '')
  if (!(HOT_COMPOSER_DRAFT_KEY in composerDraftByRunId) && composerDraft) {
    composerDraftByRunId[HOT_COMPOSER_DRAFT_KEY] = composerDraft
  } else if (values.composerDraft !== undefined) {
    composerDraftByRunId[HOT_COMPOSER_DRAFT_KEY] = values.composerDraft
  }
  const sessionQuery =
    values.sessionQuery !== undefined
      ? values.sessionQuery
      : (prev?.sessionQuery ?? '')

  if (
    prev &&
    prev.composerDraft === composerDraft &&
    prev.sessionQuery === sessionQuery &&
    Object.keys(composerDraftByRunId).length ===
      Object.keys(prev.composerDraftByRunId).length &&
    Object.entries(composerDraftByRunId).every(
      ([k, v]) => prev.composerDraftByRunId[k] === v
    )
  ) {
    return
  }
  byPath.set(path, {
    composerDraft,
    composerDraftByRunId,
    sessionQuery
  })
  notify(path)
}

export function clearWorkspaceHotUi(path: string): void {
  if (!byPath.has(path)) return
  byPath.delete(path)
  notify(path)
}

/** Subscribe a leaf component to hot UI for one workspace (does not re-render parents). */
export function useWorkspaceHotUi(path: string | null | undefined): WorkspaceHotUi {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeWorkspaceHotUi(path, onStoreChange),
    [path]
  )
  const getSnapshot = useCallback(() => getWorkspaceHotUi(path), [path])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Subscribe to the composer draft for one workspace + run. */
export function useWorkspaceHotComposerDraft(
  path: string | null | undefined,
  runId: string | null | undefined
): string {
  const hot = useWorkspaceHotUi(path)
  return resolveHotComposerDraft(hot, runId)
}

/** Test helper — reset module state between cases. */
export function resetWorkspaceHotUiStoreForTests(): void {
  byPath.clear()
  listenersByPath.clear()
  globalListeners.clear()
  globalRevision = 0
}
