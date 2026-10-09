import { describe, expect, it } from 'vitest'
import { recordNav, type NavLocation, type NavTrail } from '@renderer/app/useNavHistory'

const at = (view: NavLocation['view'], runId: string | null = null): NavLocation => ({
  view,
  workspacePath: runId ? 'C:\\ws' : null,
  runId
})

describe('recordNav', () => {
  it('records each move once, and a move after going back drops the forward steps', () => {
    let trail: NavTrail = { entries: [], index: -1 }
    trail = recordNav(trail, at('chat', 'a'))
    trail = recordNav(trail, at('chat', 'a'))
    trail = recordNav(trail, at('settings'))
    trail = recordNav(trail, at('chat', 'b'))
    expect(trail.entries).toHaveLength(3)
    // Back twice, then somewhere new: "b" is gone from Forward.
    trail = { ...trail, index: 0 }
    trail = recordNav(trail, at('usage'))
    expect(trail.entries.map((e) => e.view + (e.runId ?? ''))).toEqual(['chata', 'usage'])
    expect(trail.index).toBe(1)
  })

  it('keeps the newest fifty', () => {
    let trail: NavTrail = { entries: [], index: -1 }
    for (let i = 0; i < 60; i++) trail = recordNav(trail, at('chat', `r${i}`))
    expect(trail.entries).toHaveLength(50)
    expect(trail.entries[0]!.runId).toBe('r10')
  })
})
