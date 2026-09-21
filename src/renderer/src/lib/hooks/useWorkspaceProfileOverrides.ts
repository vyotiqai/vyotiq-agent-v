import { useSyncExternalStore } from 'react'
import type { AgentProfileOverride } from '@shared/ipc'

/**
 * Per-workspace teammate overrides, shared across the renderer.
 *
 * A workspace may retune a global teammate for one project through a
 * git-shareable `.vyotiq/agents/<id>.profile.json`. Main has merged that file
 * into every run for a long time; until now nothing in the app could write
 * one, so the feature existed only for people willing to hand-author JSON.
 *
 * A module store from the start, for the same reason the roster and the task
 * queue became one: more than one surface will read this, and two copies of an
 * override map is two answers to "what will this teammate actually do here".
 */

type OverrideMap = Record<string, AgentProfileOverride>

/** Profile id -> the privileged fields its override asks for but has not been granted. */
type UnacceptedMap = Record<string, string[]>

type OverridesState = {
  /** Workspace path -> profile id -> override. Absent = not loaded yet. */
  byWorkspace: Record<string, OverrideMap>
  /**
   * Workspace path -> what the run path is withholding.
   *
   * An override file arrives over git, so it may ask to run a teammate
   * autonomously in a repository the user merely cloned. Those fields are
   * dropped until accepted, and this is how the UI can say so instead of
   * leaving the user to wonder why a committed setting has no effect.
   */
  unacceptedByWorkspace: Record<string, UnacceptedMap>
  error: string | null
}

const EMPTY: OverridesState = { byWorkspace: {}, unacceptedByWorkspace: {}, error: null }

let state: OverridesState = EMPTY
const listeners = new Set<() => void>()
const requested = new Set<string>()
let subscribed = false

function getSnapshot(): OverridesState {
  return state
}

function publish(next: OverridesState): void {
  if (
    next.byWorkspace === state.byWorkspace &&
    next.unacceptedByWorkspace === state.unacceptedByWorkspace &&
    next.error === state.error
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

function applyWorkspace(
  workspacePath: string,
  overrides: OverrideMap,
  unaccepted: UnacceptedMap
): void {
  publish({
    ...state,
    byWorkspace: { ...state.byWorkspace, [workspacePath]: overrides },
    unacceptedByWorkspace: { ...state.unacceptedByWorkspace, [workspacePath]: unaccepted }
  })
}

function subscribeToPush(): void {
  if (subscribed) return
  if (!window.vyotiq?.onAgentProfileOverridesChanged) return
  subscribed = true
  // Never torn down: one listener for the app's lifetime, matching the roster
  // and task stores. A workspace whose overrides changed while no consumer was
  // mounted must not be left stale for the next one.
  window.vyotiq.onAgentProfileOverridesChanged((event) => {
    applyWorkspace(event.workspacePath, event.overrides, event.unaccepted ?? {})
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  subscribeToPush()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Load a workspace's overrides once. Main only knows workspaces this session
 * has opened, so a closed one is simply absent rather than empty.
 */
function ensureLoaded(workspacePath: string): void {
  if (!workspacePath || requested.has(workspacePath)) return
  if (!window.vyotiq?.agentProfileOverridesList) return
  requested.add(workspacePath)
  void window.vyotiq.agentProfileOverridesList({ workspacePath }).then((res) => {
    if (res?.ok) {
      applyWorkspace(res.data.workspacePath, res.data.overrides, res.data.unaccepted ?? {})
      return
    }
    // Let it be retried: a workspace that was not open yet is an ordinary
    // state, not a permanent failure.
    requested.delete(workspacePath)
  })
}

/**
 * Write or clear one override. The write replaces the stored file, so callers
 * pass the complete override they want — including any field they do not
 * themselves edit.
 */
async function setOverride(
  workspacePath: string,
  profileId: string,
  override: AgentProfileOverride | null
): Promise<boolean> {
  const res = await window.vyotiq?.agentProfileOverrideSet?.({
    workspacePath,
    profileId,
    override
  })
  if (res?.ok) return true
  publish({ ...state, error: res?.error ?? 'Workspace overrides are unavailable' })
  return false
}

/**
 * Grant this workspace's override file its privileged fields as written.
 *
 * Main re-hashes the file itself rather than trusting anything from here, so
 * this cannot approve bytes the renderer invented.
 */
async function acceptOverride(workspacePath: string, profileId: string): Promise<boolean> {
  const res = await window.vyotiq?.agentProfileOverrideAccept?.({ workspacePath, profileId })
  if (res?.ok) {
    applyWorkspace(res.data.workspacePath, res.data.overrides, res.data.unaccepted ?? {})
    return true
  }
  publish({ ...state, error: res?.error ?? 'Workspace overrides are unavailable' })
  return false
}

function clearError(): void {
  publish({ ...state, error: null })
}

/** Test hook — drop shared override state so suites cannot leak into each other. */
export function resetWorkspaceProfileOverridesForTests(): void {
  state = EMPTY
  listeners.clear()
  requested.clear()
  subscribed = false
}

export function useWorkspaceProfileOverrides(): {
  byWorkspace: Record<string, OverrideMap>
  unacceptedByWorkspace: Record<string, UnacceptedMap>
  error: string | null
  ensureLoaded: (workspacePath: string) => void
  setOverride: (
    workspacePath: string,
    profileId: string,
    override: AgentProfileOverride | null
  ) => Promise<boolean>
  acceptOverride: (workspacePath: string, profileId: string) => Promise<boolean>
  clearError: () => void
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    byWorkspace: snapshot.byWorkspace,
    unacceptedByWorkspace: snapshot.unacceptedByWorkspace,
    error: snapshot.error,
    ensureLoaded,
    setOverride,
    acceptOverride,
    clearError
  }
}
