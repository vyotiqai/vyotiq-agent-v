import { describe, expect, it } from 'vitest'
import { finishedBackgroundRuns } from '@renderer/lib/chat/backgroundRuns'

describe('finishedBackgroundRuns', () => {
  it('finds only ids that were marked background and left the active list', () => {
    const prev = [
      { runId: 'bg', workspacePath: '/ws' },
      { runId: 'open', workspacePath: '/ws' }
    ]
    const next = [{ runId: 'open', workspacePath: '/ws' }]
    expect(finishedBackgroundRuns(prev, next, new Set(['bg']))).toEqual([
      { runId: 'bg', workspacePath: '/ws' }
    ])
    expect(finishedBackgroundRuns(prev, next, new Set())).toEqual([])
  })
})
