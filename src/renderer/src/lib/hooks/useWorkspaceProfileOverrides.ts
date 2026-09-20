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

type OverridesState = {
  /** Workspace path -> profile id -> override. Absent = not loaded yet. */
  byWorkspace: Record<string, OverrideMap>
  error: string | null
}

const EMPTY: OverridesState = { byWorkspace: {}, error: null }

let state: OverridesState = EMPTY
const listeners = new Set<() => void>()
const requested = new Set<string>()
let subscribed = false

function getSnapshot(): OverridesState {
  return state
}

function publish(next: OverridesState): void {
  if (next.byWorkspace === state.byWorkspace && next.error === state.error) return
  state = next
  for (const listener of listeners) listener()
}

function applyWorkspace(workspacePath: string, overrides: OverrideMap): void {
  publish({
    ...state,
    byWorkspace: { ...state.byWorkspace, [workspacePath]: overrides }
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
    applyWorkspace(event.workspacePath, event.overrides)
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
      applyWorkspace(res.data.workspacePath, res.data.overrides)
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
  error: string | null
  ensureLoaded: (workspacePath: string) => void
  setOverride: (
    workspacePath: string,
    profileId: string,
    override: AgentProfileOverride | null
  ) => Promise<boolean>
  clearError: () => void
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    byWorkspace: snapshot.byWorkspace,
    error: snapshot.error,
    ensureLoaded,
    setOverride,
    clearError
  }
}
