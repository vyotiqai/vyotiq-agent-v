import { useCallback, useEffect, useState } from 'react'

const PROBE_INTERVAL_MS = 15_000

async function probeViaMain(): Promise<boolean | null> {
  if (typeof window === 'undefined' || !window.vyotiq?.probeNetwork) return null
  try {
    const res = await window.vyotiq.probeNetwork()
    if (res.ok) return res.data
  } catch {
    // Fall through to navigator.onLine
  }
  return null
}

export function useNetworkStatus(): { online: boolean; offlineHint: string | null } {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  const refresh = useCallback(async (): Promise<void> => {
    const probed = await probeViaMain()
    if (probed !== null) {
      // Probe can fail on blocked endpoints while the browser still reports online.
      setOnline(probed || (typeof navigator !== 'undefined' && navigator.onLine))
      return
    }
    if (typeof navigator !== 'undefined') {
      setOnline(navigator.onLine)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onBrowserChange = (): void => {
      void refresh()
    }
    window.addEventListener('online', onBrowserChange)
    window.addEventListener('offline', onBrowserChange)
    const timer = window.setInterval(() => {
      // Hidden windows skip probe ticks (audit L1); the visibilitychange/focus
      // listeners below refire a probe immediately on regain.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh()
    }, PROBE_INTERVAL_MS)
    const onFocus = (): void => {
      void refresh()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', onBrowserChange)
      window.removeEventListener('offline', onBrowserChange)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  return {
    online,
    offlineHint: online
      ? null
      : 'You appear to be offline. Agent runs will retry when connectivity returns.'
  }
}
