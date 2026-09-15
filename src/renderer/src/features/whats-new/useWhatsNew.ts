import { useCallback, useEffect, useRef, useState } from 'react'
import type { ParsedReleaseNotes } from '@shared/utils/releaseNotes'
import {
  LAST_SEEN_UPDATE_VERSION_KEY,
  PENDING_NOTES_KEY,
  PendingNotes
} from '../updates/useUpdater'

export interface UseWhatsNew {
  /** True while the post-restart modal is visible. */
  open: boolean
  /** Running app version from the main process, once known. */
  currentVersion: string | null
  /** Version recorded at the end of the previous run (modal subtitle). */
  lastRunVersion: string | null
  /** Notes handed over by Stage A across the restart, when available. */
  pendingNotes: ParsedReleaseNotes | null
  /** Dismiss the modal and record the running version as seen. */
  dismiss: () => void
}

/** Compare two dotted version strings; negative when `a < b`, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.')
  const bs = b.split('.')
  const length = Math.max(as.length, bs.length)
  for (let i = 0; i < length; i++) {
    const av = Number.parseInt(as[i] ?? '0', 10)
    const bv = Number.parseInt(bs[i] ?? '0', 10)
    if (Number.isNaN(av) || Number.isNaN(bv)) {
      const byString = (as[i] ?? '').localeCompare(bs[i] ?? '')
      if (byString !== 0) return byString
      continue
    }
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

/**
 * Read the notes payload Stage A persisted before the install restart.
 * Returns null when absent, malformed, or stamped for a different version.
 */
function readPendingNotes(version: string): ParsedReleaseNotes | null {
  try {
    const raw = window.localStorage.getItem(PENDING_NOTES_KEY)
    if (!raw) return null
    const candidate = JSON.parse(raw) as Partial<PendingNotes> | null
    if (
      typeof candidate !== 'object' ||
      candidate == null ||
      candidate.version !== version ||
      typeof candidate.notesText !== 'string' ||
      !Array.isArray(candidate.notesSections)
    ) {
      return null
    }
    return { notesText: candidate.notesText, notesSections: candidate.notesSections }
  } catch {
    return null
  }
}

/**
 * Stage B gate (Workstream 4). On mount, compares the running version
 * (`app.getVersion()` via the existing `getAppInfo` bridge) against the
 * `vyotiq.updates.lastSeenVersion` key persisted by Stage A:
 *
 * - stored key null (first install ever): record the version, show nothing.
 * - stored equal to running version: normal launch, show nothing.
 * - stored lower than running version: app was updated — open the modal and
 *   consume the pending notes Stage A persisted across the restart.
 * - stored higher (downgrade): re-sync the key, show nothing.
 *
 * Runs once per mount; state writes are idempotent so re-invocation is safe.
 */
export function useWhatsNew(): UseWhatsNew {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [lastRunVersion, setLastRunVersion] = useState<string | null>(null)
  const [pendingNotes, setPendingNotes] = useState<ParsedReleaseNotes | null>(null)
  const [open, setOpen] = useState(false)
  const gateRanRef = useRef(false)

  useEffect(() => {
    if (gateRanRef.current) return
    gateRanRef.current = true

    const decide = async (): Promise<void> => {
      try {
        const bridge = window.vyotiq
        if (!bridge) return
        const result = await bridge.getAppInfo()
        if (!result.ok) return
        const version = result.data.version

        const stored = window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)
        const clearPending = (): void => {
          window.localStorage.removeItem(PENDING_NOTES_KEY)
        }

        if (stored == null) {
          // First install ever: record the version, show nothing.
          window.localStorage.setItem(LAST_SEEN_UPDATE_VERSION_KEY, version)
          clearPending()
          setCurrentVersion(version)
          return
        }

        const comparison = compareVersions(version, stored)
        if (comparison <= 0) {
          // Equal: normal launch. Stored higher than the running version
          // (downgrade): re-sync the key. No modal either way.
          if (comparison < 0) {
            window.localStorage.setItem(LAST_SEEN_UPDATE_VERSION_KEY, version)
          }
          clearPending()
          setCurrentVersion(version)
          return
        }

        // App was updated: open the modal and consume the pending notes.
        const notes = readPendingNotes(version)
        clearPending()
        setCurrentVersion(version)
        setLastRunVersion(stored)
        setPendingNotes(notes)
        setOpen(true)
      } catch {
        // Bridge unavailable or failed: stay closed; the next launch retries.
      }
    }

    void decide()
  }, [])

  const dismiss = useCallback((): void => {
    setOpen(false)
    if (currentVersion != null) {
      window.localStorage.setItem(LAST_SEEN_UPDATE_VERSION_KEY, currentVersion)
    }
    window.localStorage.removeItem(PENDING_NOTES_KEY)
  }, [currentVersion])

  return { open, currentVersion, lastRunVersion, pendingNotes, dismiss }
}
