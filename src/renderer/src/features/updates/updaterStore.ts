import { useCallback, useSyncExternalStore } from 'react'
import type { UpdateInfo, UpdateProgress, UpdaterStatePayload } from '@shared/ipc'

/**
 * The renderer's single source of truth for app updates.
 *
 * One `updater:state` subscription for the whole window, seeded once from the
 * `updater:get-state` pull so mounting a consumer never triggers a network
 * check. Every surface (the sidebar rail entry and Settings → About) reads
 * this store instead of keeping its own copy.
 *
 * Downloads and installs are always user-initiated — main keeps
 * `autoDownload` off and nothing here ever calls `download()` on its own.
 */

/** localStorage key: the available version whose panel has already opened itself. */
export const ANNOUNCED_VERSION_KEY = 'vyotiq.updates.announcedVersion'

/** localStorage key holding notes handed to the What's New modal across a restart. */
export const PENDING_NOTES_KEY = 'vyotiq.updates.pendingNotes'

/** Notes payload handed across the install restart. */
export interface PendingNotes {
  version: string
  notesText: string
  notesSections: UpdateInfo['notesSections']
}

const IDLE: UpdaterStatePayload = { status: 'idle' }

let state: UpdaterStatePayload = IDLE
let announced: string | null = null
let started = false
let stopListening: (() => void) | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function readBridge(): typeof window.vyotiq.updater | null {
  return window.vyotiq?.updater ?? null
}

function readAnnounced(): string | null {
  try {
    return window.localStorage.getItem(ANNOUNCED_VERSION_KEY)
  } catch {
    return null
  }
}

function setState(next: UpdaterStatePayload): void {
  if (next === state) return
  state = next
  emit()
}

/**
 * Attach on first use and seed once. Driven by `subscribe()` rather than an
 * explicit init call, so no app root has to remember to start it and a test
 * that mounts a single consumer behaves like production.
 *
 * Safe with no preload bridge (older preload, and the settings test suite,
 * which mocks `window.vyotiq` without an `updater` namespace): it returns
 * having changed nothing, and consumers read the idle snapshot.
 */
function ensureAttached(): void {
  if (started) return
  const bridge = readBridge()
  if (!bridge) return
  started = true
  announced = readAnnounced()
  stopListening = bridge.onState((payload) => {
    setState(payload)
  })
  // Pull, don't check: seeding must not cost a network round trip.
  void bridge
    .getState()
    .then((res) => {
      // A push that landed first is newer than this snapshot, so it wins.
      if (res.ok && state === IDLE) setState(res.data)
    })
    .catch(() => {
      // Nothing actionable: the push channel reports real state as it changes.
    })
}

export function getUpdaterState(): UpdaterStatePayload {
  return state
}

export function getAnnouncedVersion(): string | null {
  return announced
}

function subscribe(listener: () => void): () => void {
  ensureAttached()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current updater state — the same payload main broadcasts. */
export function useUpdaterState(): UpdaterStatePayload {
  const sub = useCallback((onStoreChange: () => void) => subscribe(onStoreChange), [])
  return useSyncExternalStore(sub, getUpdaterState, getUpdaterState)
}

function useAnnouncedVersion(): string | null {
  const sub = useCallback((onStoreChange: () => void) => subscribe(onStoreChange), [])
  return useSyncExternalStore(sub, getAnnouncedVersion, getAnnouncedVersion)
}

export interface UpdateAnnouncement {
  /** Non-null while the sidebar entry should render. */
  info: UpdateInfo | null
  status: UpdaterStatePayload['status']
  /** Non-null only while downloading. */
  progress: UpdateProgress | null
  /** Why the last step failed, while the update it was about is still known. */
  error: string | null
  /** True until this version's panel has opened itself once. */
  autoOpen: boolean
}

/**
 * Drives the sidebar rail entry. The entry is persistent while an update
 * exists — there is no dismissal, because a quiet rail item cannot get in the
 * way and hiding it is what used to strand users on an old version.
 */
export function useUpdateAnnouncement(): UpdateAnnouncement {
  const current = useUpdaterState()
  const announcedVersion = useAnnouncedVersion()
  const pending =
    current.status === 'available' ||
    current.status === 'downloading' ||
    current.status === 'downloaded' ||
    // A failed download of a known update keeps the entry: it is where you retry.
    (current.status === 'error' && current.info != null)
  const info = pending ? (current.info ?? null) : null
  return {
    info,
    status: current.status,
    progress: current.status === 'downloading' ? (current.progress ?? null) : null,
    error: current.status === 'error' && info ? (current.error ?? 'The update failed') : null,
    autoOpen: info != null && info.version !== announcedVersion
  }
}

/** Record that this version's panel has opened itself, so it does not again. */
export function markAnnounced(version: string): void {
  if (announced === version) return
  announced = version
  try {
    window.localStorage.setItem(ANNOUNCED_VERSION_KEY, version)
  } catch {
    // Persistence is best-effort; it still holds for this session.
  }
  emit()
}

/** Explicit user action — always allowed, even with automatic checks off. */
export async function checkForUpdates(): Promise<void> {
  await readBridge()?.check()
}

export function downloadUpdate(): void {
  void readBridge()
    ?.download()
    .catch(() => {
      // The push channel reports the error state.
    })
}

export function installUpdate(): void {
  // Hand the parsed notes to the post-restart What's New modal. Best-effort:
  // it falls back to a generic line plus a release-notes link when absent.
  const info = state.info
  if (info != null) {
    try {
      const pending: PendingNotes = {
        version: info.version,
        notesText: info.notesText,
        notesSections: info.notesSections
      }
      window.localStorage.setItem(PENDING_NOTES_KEY, JSON.stringify(pending))
    } catch {
      // Still proceed with the install.
    }
  }
  void readBridge()
    ?.install()
    .catch(() => {
      // The push channel reports the error state.
    })
}

/** Test helper — drop state, listeners and the subscription between cases. */
export function resetUpdaterStoreForTests(): void {
  stopListening?.()
  stopListening = null
  started = false
  state = IDLE
  announced = null
  listeners.clear()
}

/** Test helper — push a state payload without a bridge. */
export function setUpdaterStateForTests(next: UpdaterStatePayload): void {
  setState(next)
}
