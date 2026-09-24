import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ComposerAttachmentsBucket, IpcResult, TaskDraft } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { taskTitleFromGoal } from '@shared/utils/taskTitle'

/**
 * New task drafts, per workspace, as main keeps them (drafts.json under the
 * app's data). Loaded the first time a workspace's drafts are asked for, then
 * kept current by every save and delete made through here.
 *
 * Also the New task page's checks and the draft it continues, per workspace
 * (`useBriefState`), so opening a draft is only a matter of setting them.
 */

/** What a draft is called: its brief's first line, or its first check when the brief is empty. */
export function draftTitle(draft: Pick<TaskDraft, 'brief' | 'doneWhen'>): string {
  return taskTitleFromGoal(draft.brief) || draft.doneWhen[0] || 'Untitled draft'
}

type Listener = () => void

const draftsByWorkspace = new Map<string, TaskDraft[]>()
const loading = new Set<string>()
/** A read asked for while one was out: read once more when it returns. */
const readAgain = new Set<string>()
/** Bumped by every change made here, so a list read before it can't undo it. */
const localChanges = new Map<string, number>()
const listeners = new Set<Listener>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function keyOf(workspacePath: string): string {
  for (const key of draftsByWorkspace.keys()) if (workspacePathsEqual(key, workspacePath)) return key
  return workspacePath
}

function setDrafts(workspacePath: string, drafts: TaskDraft[]): void {
  const key = keyOf(workspacePath)
  localChanges.set(key, (localChanges.get(key) ?? 0) + 1)
  draftsByWorkspace.set(keyOf(workspacePath), [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  // A draft that is gone — started, or deleted — is no longer being continued;
  // the page keeps what is typed on it.
  const brief = briefs.get(briefKeyOf(workspacePath))
  if (brief?.draftId && !drafts.some((d) => d.id === brief.draftId)) {
    briefs.set(briefKeyOf(workspacePath), { ...brief, draftId: null })
  }
  emit()
}

/** Read a workspace's drafts from main (again). */
export async function refreshTaskDrafts(workspacePath: string): Promise<void> {
  const list = window.vyotiq?.listTaskDrafts
  if (!list) return
  const key = keyOf(workspacePath)
  // One read at a time per workspace; one asked for meanwhile runs after it,
  // since main may have changed the list since the first was sent.
  if (loading.has(key)) {
    readAgain.add(key)
    return
  }
  loading.add(key)
  try {
    do {
      readAgain.delete(key)
      const changesBefore = localChanges.get(key) ?? 0
      const res = await list(workspacePath)
      // A save or delete here while it was out is newer than what it read.
      if (res.ok && (localChanges.get(key) ?? 0) === changesBefore) setDrafts(workspacePath, res.data.drafts)
    } while (readAgain.has(key))
  } finally {
    loading.delete(key)
  }
}

export function taskDraftsFor(workspacePath: string): readonly TaskDraft[] {
  return draftsByWorkspace.get(keyOf(workspacePath)) ?? []
}

/**
 * Drafts of every workspace given, loading any not read yet. `revision`
 * changing reads them all again — main removes a draft when a task starts
 * from it, and a new task is what moves the revision.
 */
export function useTaskDrafts(
  workspacePaths: readonly string[],
  revision: string | number = 0
): Array<{ workspacePath: string; draft: TaskDraft }> {
  useSyncExternalStore(subscribe, () => version)
  const joined = workspacePaths.join('\u0000')
  const seenRevision = useRef(revision)
  useEffect(() => {
    const again = seenRevision.current !== revision
    seenRevision.current = revision
    for (const path of joined ? joined.split('\u0000') : []) {
      if (again || !draftsByWorkspace.has(keyOf(path))) void refreshTaskDrafts(path)
    }
  }, [joined, revision])
  return workspacePaths.flatMap((workspacePath) => taskDraftsFor(workspacePath).map((draft) => ({ workspacePath, draft })))
}

export async function saveTaskDraftFor(req: {
  workspacePath: string
  id?: string | null
  brief: string
  doneWhen: string[]
  attachments?: ComposerAttachmentsBucket
}): Promise<IpcResult<TaskDraft>> {
  const save = window.vyotiq?.saveTaskDraft
  if (!save) return { ok: false, error: 'Drafts are unavailable in this window.' }
  const res = await save({
    workspacePath: req.workspacePath,
    ...(req.id ? { id: req.id } : {}),
    brief: req.brief,
    doneWhen: req.doneWhen,
    ...(req.attachments ? { attachments: req.attachments } : {})
  })
  if (res.ok) {
    setDrafts(req.workspacePath, [res.data, ...taskDraftsFor(req.workspacePath).filter((d) => d.id !== res.data.id)])
  }
  return res
}

export async function deleteTaskDraftFor(workspacePath: string, id: string): Promise<IpcResult<boolean>> {
  const remove = window.vyotiq?.deleteTaskDraft
  if (!remove) return { ok: false, error: 'Drafts are unavailable in this window.' }
  const res = await remove(workspacePath, id)
  if (res.ok) setDrafts(workspacePath, taskDraftsFor(workspacePath).filter((d) => d.id !== id))
  return res
}

/**
 * The New task page's own state per workspace, beyond its text (which the
 * composer's draft store keeps): the checks typed so far and the draft being
 * continued. Kept here, not in the page, so leaving New task and coming back
 * loses neither — and so a start made anywhere can empty it.
 */
export type BriefState = {
  /** The draft being continued — Update draft saves over it; starting spends it. */
  draftId: string | null
  checks: string[]
  /** Start it in a new worktree rather than in this folder. */
  worktree?: boolean
}

const EMPTY_BRIEF: BriefState = Object.freeze({ draftId: null, checks: [], worktree: false }) as BriefState
const briefs = new Map<string, BriefState>()

function briefKeyOf(workspacePath: string): string {
  for (const key of briefs.keys()) if (workspacePathsEqual(key, workspacePath)) return key
  return workspacePath
}

export function briefStateFor(workspacePath: string | null | undefined): BriefState {
  return workspacePath ? (briefs.get(briefKeyOf(workspacePath)) ?? EMPTY_BRIEF) : EMPTY_BRIEF
}

export function setBriefState(workspacePath: string, next: BriefState | null): void {
  const key = briefKeyOf(workspacePath)
  if (next == null || (next.draftId == null && next.checks.length === 0 && !next.worktree)) briefs.delete(key)
  else briefs.set(key, { draftId: next.draftId, checks: [...next.checks], worktree: Boolean(next.worktree) })
  emit()
}

export function setBriefWorktree(workspacePath: string, worktree: boolean): void {
  setBriefState(workspacePath, { ...briefStateFor(workspacePath), worktree })
}

export function setBriefChecks(workspacePath: string, checks: string[]): void {
  setBriefState(workspacePath, { ...briefStateFor(workspacePath), checks })
}

export function useBriefState(workspacePath: string | null | undefined): BriefState {
  useSyncExternalStore(subscribe, () => version)
  return briefStateFor(workspacePath)
}

export function resetTaskDraftStoreForTests(): void {
  draftsByWorkspace.clear()
  loading.clear()
  readAgain.clear()
  localChanges.clear()
  briefs.clear()
  emit()
}
