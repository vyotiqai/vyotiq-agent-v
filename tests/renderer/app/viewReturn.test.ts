import { describe, expect, it } from 'vitest'
import { nextViewReturns, type AppView, type ViewReturns } from '@renderer/app/viewReturn'

function walk(path: AppView[]): ViewReturns {
  let returns: ViewReturns = { settings: 'chat', marketplace: 'chat' }
  for (let i = 1; i < path.length; i++) returns = nextViewReturns(path[i - 1]!, path[i]!, returns)
  return returns
}

describe('nextViewReturns', () => {
  it('closes Extensions back to the view that opened it', () => {
    expect(walk(['home', 'marketplace']).marketplace).toBe('home')
    expect(walk(['usage', 'marketplace']).marketplace).toBe('usage')
  })

  it('goes Settings → Extensions → back to Settings → back to where Settings came from', () => {
    const r = walk(['home', 'settings', 'marketplace', 'settings'])
    expect(r.marketplace).toBe('settings')
    // Returning to Settings must not make its Back point at Extensions.
    expect(r.settings).toBe('home')
  })

  it('does the same the other way round', () => {
    const r = walk(['usage', 'marketplace', 'settings', 'marketplace'])
    expect(r.settings).toBe('marketplace')
    expect(r.marketplace).toBe('usage')
  })

  it('keeps the same object when nothing changes', () => {
    const start: ViewReturns = { settings: 'chat', marketplace: 'chat' }
    expect(nextViewReturns('chat', 'home', start)).toBe(start)
  })
})
