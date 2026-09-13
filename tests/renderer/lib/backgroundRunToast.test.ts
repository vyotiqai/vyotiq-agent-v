import { describe, expect, it } from 'vitest'
import {
  backgroundRunFinishedMessage,
  finishedBackgroundRuns,
  shouldShowBackgroundRunToast
} from '@renderer/lib/chat/backgroundRunToast'

describe('finishedBackgroundRuns', () => {
  it('toasts only ids that were marked background and left the active list', () => {
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

describe('backgroundRunFinishedMessage', () => {
  it('uses the run title when present', () => {
    expect(backgroundRunFinishedMessage('Fix tests')).toBe('Finished: Fix tests')
    expect(backgroundRunFinishedMessage('  ')).toBe('Agent finished')
    expect(backgroundRunFinishedMessage(null)).toBe('Agent finished')
  })
})

describe('shouldShowBackgroundRunToast', () => {
  it('shows only when the window is focused on another tab', () => {
    expect(
      shouldShowBackgroundRunToast({
        windowFocused: true,
        focusedRunId: 'other',
        finishedRunId: 'bg'
      })
    ).toBe(true)
    expect(
      shouldShowBackgroundRunToast({
        windowFocused: false,
        focusedRunId: 'other',
        finishedRunId: 'bg'
      })
    ).toBe(false)
    expect(
      shouldShowBackgroundRunToast({
        windowFocused: true,
        focusedRunId: 'bg',
        finishedRunId: 'bg'
      })
    ).toBe(false)
  })
})
