import { useEffect, useState } from 'react'
import type { UpdateInfo, UpdateProgress, UpdaterBridge, UpdaterState } from './types'

/** localStorage key holding the version the user last dismissed. */
export const LAST_SEEN_UPDATE_VERSION_KEY = 'vyotiq.updates.lastSeenVersion'

/** Read the preload bridge without assuming it exists (older preload / tests). */
function readUpdaterBridge(): UpdaterBridge | null {
  const api = (window as unknown as { vyotiq?: { updater?: UpdaterBridge } }).vyotiq
  return api?.updater ?? null
}

function readLastSeenVersion(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)
  } catch {
    return null
  }
}

export function useUpdater(): {
  /** Non-null while the card should render. */
  info: UpdateInfo | null
  status: UpdaterState['status']
  /** Non-null only while downloading. */
  progress: UpdateProgress | null
  download: () => void
  install: () => void
  dismiss: () => void
} {
  const [state, setState] = useState<UpdaterState | null>(null)
  const [lastSeenVersion, setLastSeenVersion] = useState<string | null>(readLastSeenVersion)

  useEffect(() => {
    const bridge = readUpdaterBridge()
    if (!bridge) return
    let active = true
    const unsubscribe = bridge.onState((next) => {
      if (active) setState(next)
    })
    // Exactly one check per mount. check() and onState both carry info; the
    // first writer wins so a fast check() never clobbers a live onState.
    // The bridge resolves an IpcResult envelope — unwrap `data` before use.
    void bridge
      .check()
      .then((res) => {
        if (!active || !res.ok || res.data == null) return
        const info = res.data
        setState((prev) => prev ?? { status: 'available', info })
      })
      .catch(() => {
        // onState reports the error state; a rejected check() is non-actionable.
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const status = state?.status ?? 'idle'
  const info = state?.info ?? null
  const isNewVersion = info != null && info.version !== lastSeenVersion
  const isVisible =
    isNewVersion &&
    (status === 'available' || status === 'downloading' || status === 'downloaded')

  const download = (): void => {
    void readUpdaterBridge()?.download().catch(() => {})
  }

  const install = (): void => {
    void readUpdaterBridge()?.install().catch(() => {})
  }

  const dismiss = (): void => {
    if (info == null || !isNewVersion) return
    try {
      window.localStorage.setItem(LAST_SEEN_UPDATE_VERSION_KEY, info.version)
    } catch {
      // Persistence is best-effort; still hide for this mount.
    }
    setLastSeenVersion(info.version)
  }

  return {
    info: isVisible ? info : null,
    status,
    progress: isVisible && status === 'downloading' ? (state?.progress ?? null) : null,
    download,
    install,
    dismiss
  }
}
