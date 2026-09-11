import { useEffect, useMemo, useState } from 'react'
import type { MarketplaceIndex, MarketplaceInstalledItem } from '@shared/ipc'

/**
 * Marketplace installs are recorded with an `installedAt` timestamp
 * (MarketplaceInstalledItemSchema); this picks the ones inside the look-back
 * window, newest first. MCP servers configured outside the marketplace carry
 * no timestamps anywhere in their status schema — they are correctly absent
 * (never a fabricated date).
 */
export function recentMarketplaceActivity(
  items: readonly MarketplaceInstalledItem[],
  now: Date,
  withinDays = 14,
  cap = 3
): MarketplaceInstalledItem[] {
  const cutoff = now.getTime() - withinDays * 86_400_000
  return items
    .filter((item) => {
      const ts = new Date(item.installedAt).getTime()
      return Number.isFinite(ts) && ts >= cutoff
    })
    .sort((a, b) => (a.installedAt < b.installedAt ? 1 : a.installedAt > b.installedAt ? -1 : 0))
    .slice(0, cap)
}

/**
 * Recent marketplace installs (skills / MCP / plugins) for the Home tab.
 * One-shot on mount + focus/visibility refetch — installs happen in the
 * Marketplace surface, so returning to Home (remount or window refocus) is
 * the natural refresh; no polling (perf rule). No bridge → undefined and the
 * section stays hidden rather than zero-filled.
 */
export function useMarketplaceActivity(): MarketplaceInstalledItem[] | undefined {
  const [items, setItems] = useState<MarketplaceInstalledItem[] | undefined>(undefined)

  useEffect(() => {
    let active = true
    const load = (): void => {
      const api = window.vyotiq?.marketplaceListInstalled
      if (!api) return
      void api().then((res) => {
        if (!active) return
        if (res.ok) setItems(res.data.items)
      })
    }

    load()
    const onRegainAttention = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    window.addEventListener('focus', onRegainAttention)
    document.addEventListener('visibilitychange', onRegainAttention)
    return () => {
      active = false
      window.removeEventListener('focus', onRegainAttention)
      document.removeEventListener('visibilitychange', onRegainAttention)
    }
  }, [])

  return items
}

/** Convenience for the panel: hook result → display-ready recent list. */
export function useRecentMarketplaceActivity(): MarketplaceInstalledItem[] {
  const items = useMarketplaceActivity()
  // Window cut-off computed only when the install set changes (mount/focus
  // refetch) — never per render. A 14-day look-back is insensitive to the
  // exact instant the window was captured.
  return useMemo(
    () => (items ? recentMarketplaceActivity(items, new Date()) : []),
    [items]
  )
}

export type { MarketplaceIndex }
