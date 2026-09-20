import { useSyncExternalStore } from 'react'
import type {
  AgentProfile,
  AgentProfileCreateRequest,
  AgentProfileDeleteResult,
  AgentProfileUpdateRequest
} from '@shared/ipc'

/**
 * One teammate roster for the whole renderer.
 *
 * Three surfaces read this list — the sidebar section, the composer's teammate
 * picker, and App's pane routing. Each used to hold its own `useState`, which
 * meant three IPC loads and three push subscriptions, but the real problem was
 * that they could disagree:
 *
 * - an optimistic create or delete updated only the copy that issued it, so
 *   until the push arrived one surface showed a teammate another did not;
 * - `deleteProfile`'s partial-failure warnings (a locked override file, a run
 *   that refused to stop) landed in whichever copy made the call, so the
 *   surface actually showing the roster never saw them.
 *
 * A module-level store fixes both: one load, one subscription, one truth. It
 * matches the existing store hooks in this directory.
 */

type RosterState = {
  profiles: AgentProfile[]
  ready: boolean
  error: string | null
}

const EMPTY: RosterState = { profiles: [], ready: false, error: null }

let state: RosterState = EMPTY
const listeners = new Set<() => void>()
let started = false

/**
 * useSyncExternalStore compares snapshots by identity, so this must return a
 * stable reference and must not build a fresh object per call.
 */
function getSnapshot(): RosterState {
  return state
}

function setState(patch: Partial<RosterState>): void {
  const next: RosterState = { ...state, ...patch }
  // Publish only real changes: a push that repeats the current roster would
  // otherwise re-render every subscriber for nothing.
  if (
    next.profiles === state.profiles &&
    next.ready === state.ready &&
    next.error === state.error
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  // Do not latch before the preload bridge exists. Marking the load as started
  // when there is nothing to call would leave the roster empty for the rest of
  // the session; leaving it unlatched lets the next subscribe retry.
  if (!window.vyotiq?.agentProfilesList) return
  started = true
  void window.vyotiq?.agentProfilesList?.().then((res) => {
    if (res?.ok) setState({ profiles: res.data, ready: true })
    else if (res && !res.ok) setState({ error: res.error, ready: true })
    else setState({ ready: true })
  })
  // Never torn down on purpose: this is one listener for the app's lifetime.
  // Dropping it when the last subscriber unmounts would leave whatever mounts
  // next reading a roster that silently stopped receiving updates.
  window.vyotiq?.onAgentProfilesChanged?.((event) => {
    setState({ profiles: event.profiles, ready: true })
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
  }
}

async function createProfile(request: AgentProfileCreateRequest): Promise<AgentProfile | null> {
  const res = await window.vyotiq?.agentProfilesCreate?.(request)
  if (res?.ok) {
    // The push channel also refreshes; apply immediately for a snappy UI.
    setState({ profiles: [...state.profiles.filter((p) => p.id !== res.data.id), res.data] })
    return res.data
  }
  if (res && !res.ok) setState({ error: res.error })
  return null
}

async function updateProfile(request: AgentProfileUpdateRequest): Promise<AgentProfile | null> {
  const res = await window.vyotiq?.agentProfilesUpdate?.(request)
  if (res?.ok) {
    setState({ profiles: state.profiles.map((p) => (p.id === res.data.id ? res.data : p)) })
    return res.data
  }
  if (res && !res.ok) setState({ error: res.error })
  return null
}

/**
 * Returns the delete result rather than a bare boolean. Main reports how many
 * tasks and runs it stopped and every caller was discarding that. Truthiness is
 * unchanged — a result on success, null on failure — so existing callers that
 * only test the outcome keep working.
 */
async function deleteProfile(id: string): Promise<AgentProfileDeleteResult | null> {
  const res = await window.vyotiq?.agentProfilesDelete?.({ id })
  if (res?.ok) {
    // The teammate is gone, but cleanup can be partial (a locked override
    // file, a run that refused to stop). Surfacing it here is the only way
    // the user learns — the roster row disappears either way.
    setState({
      profiles: state.profiles.filter((p) => p.id !== id),
      error: res.data.warnings.length > 0 ? res.data.warnings.join('\n') : null
    })
    return res.data
  }
  if (res && !res.ok) setState({ error: res.error })
  return null
}

function refresh(): void {
  void window.vyotiq?.agentProfilesList?.().then((res) => {
    if (res?.ok) setState({ profiles: res.data })
  })
}

/** Dismiss a surfaced warning or error once the user has read it. */
function clearError(): void {
  setState({ error: null })
}

/** Test hook — drop the shared roster so suites cannot leak state into each other. */
export function resetAgentProfilesStoreForTests(): void {
  state = EMPTY
  listeners.clear()
  started = false
}

/**
 * Agent-profile roster state: one shared load plus a live push subscription.
 * The mutators are module-level, so their identities are stable and a consumer
 * can depend on them without re-subscribing.
 */
export function useAgentProfiles(): {
  profiles: AgentProfile[]
  ready: boolean
  error: string | null
  createProfile: (request: AgentProfileCreateRequest) => Promise<AgentProfile | null>
  updateProfile: (request: AgentProfileUpdateRequest) => Promise<AgentProfile | null>
  deleteProfile: (id: string) => Promise<AgentProfileDeleteResult | null>
  refresh: () => void
  clearError: () => void
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    profiles: snapshot.profiles,
    ready: snapshot.ready,
    error: snapshot.error,
    createProfile,
    updateProfile,
    deleteProfile,
    refresh,
    clearError
  }
}
