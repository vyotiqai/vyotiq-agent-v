/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BROWSER_RECENTS_KEY,
  clearBrowserRecents,
  filterBrowserRecents,
  groupBrowserRecents,
  loadBrowserRecents,
  recordBrowserVisit
} from '@renderer/features/chat/components/browserRecents'

beforeEach(() => {
  localStorage.removeItem(BROWSER_RECENTS_KEY)
})

describe('browserRecents', () => {
  it('records and de-dupes by URL keeping the newest title', () => {
    recordBrowserVisit('https://a.example', 'A1')
    const items = recordBrowserVisit('https://a.example', 'A2')
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('A2')
    expect(loadBrowserRecents()).toHaveLength(1)
  })

  it('groups by Today / Yesterday / Last 7 days / Older', () => {
    const now = Date.now()
    localStorage.setItem(
      BROWSER_RECENTS_KEY,
      JSON.stringify([
        { url: 'https://today', title: 'Today', visitedAt: now },
        { url: 'https://yest', title: 'Y', visitedAt: now - 86_400_000 },
        { url: 'https://week', title: 'W', visitedAt: now - 3 * 86_400_000 },
        { url: 'https://old', title: 'O', visitedAt: now - 30 * 86_400_000 }
      ])
    )
    const groups = groupBrowserRecents(loadBrowserRecents())
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Older'])
  })

  it('filters by title or URL and clears storage', () => {
    recordBrowserVisit('https://docs.example/api', 'API Docs')
    recordBrowserVisit('https://other.example', 'Other')
    expect(filterBrowserRecents(loadBrowserRecents(), 'api')).toHaveLength(1)
    clearBrowserRecents()
    expect(loadBrowserRecents()).toEqual([])
  })
})
