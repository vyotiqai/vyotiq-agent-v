/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recentMarketplaceActivity,
  useMarketplaceActivity,
  useRecentMarketplaceActivity
} from '@renderer/features/home/useMarketplaceActivity'
import { renderHook, waitFor } from '@testing-library/react'
import type { MarketplaceInstalledItem } from '@shared/ipc'

function item(id: string, installedAt: string, kind: MarketplaceInstalledItem['kind'] = 'skill'): MarketplaceInstalledItem {
  return {
    id,
    kind,
    name: id,
    version: '1.0.0',
    description: '',
    enabled: true,
    installSource: 'registry',
    installedAt,
    packagePath: `${id}/1.0.0`
  }
}

const NOW = new Date('2026-09-09T12:00:00.000Z')

const marketplaceListInstalled = vi.fn()

describe('recentMarketplaceActivity', () => {
  it('keeps only installs inside the window, newest first, capped', () => {
    const items = [
      item('old', '2026-05-01T00:00:00.000Z'),
      item('mid', '2026-09-02T00:00:00.000Z'),
      item('newest', '2026-09-08T00:00:00.000Z'),
      item('second', '2026-09-05T00:00:00.000Z'),
      item('third', '2026-09-03T00:00:00.000Z'),
      item('fourth', '2026-09-01T00:00:00.000Z')
    ]
    const recent = recentMarketplaceActivity(items, NOW, 14, 3)
    expect(recent.map((r) => r.id)).toEqual(['newest', 'second', 'third'])
  })

  it('drops items with unparseable timestamps instead of guessing', () => {
    const items = [item('broken', 'not-a-date'), item('fresh', '2026-09-08T00:00:00.000Z')]
    expect(recentMarketplaceActivity(items, NOW).map((r) => r.id)).toEqual(['fresh'])
  })
})

describe('useMarketplaceActivity', () => {
  beforeEach(() => {
    // @ts-expect-error test bridge
    window.vyotiq = { marketplaceListInstalled }
  })

  afterEach(() => {
    // @ts-expect-error test bridge
    delete window.vyotiq
    marketplaceListInstalled.mockReset()
  })

  it('returns undefined with no bridge and the hook stays hidden', () => {
    // @ts-expect-error test bridge
    delete window.vyotiq
    const { result } = renderHook(() => useMarketplaceActivity())
    expect(result.current).toBeUndefined()
  })

  it('fetches once on mount and maps the installed index', async () => {
    marketplaceListInstalled.mockResolvedValue({
      ok: true,
      data: { schemaVersion: 1, items: [item('a', '2026-09-08T00:00:00.000Z')] }
    })
    const { result } = renderHook(() => useMarketplaceActivity())
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(marketplaceListInstalled).toHaveBeenCalledTimes(1)
  })

  it('keeps hidden on a failed fetch rather than zero-filling', async () => {
    marketplaceListInstalled.mockResolvedValue({ ok: false, error: 'boom' })
    const { result } = renderHook(() => useMarketplaceActivity())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current).toBeUndefined()
    expect(marketplaceListInstalled).toHaveBeenCalledTimes(1)
  })

  it('recent convenience list narrows to the window', async () => {
    marketplaceListInstalled.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        items: [item('old', '2026-05-01T00:00:00.000Z'), item('new', '2026-09-08T00:00:00.000Z')]
      }
    })
    const { result } = renderHook(() => useRecentMarketplaceActivity())
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe('new')
  })
})
