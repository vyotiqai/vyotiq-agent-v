import { describe, expect, it } from 'vitest'
import {
  planSecondInstanceAction,
  SECOND_INSTANCE_UNRESPONSIVE_THRESHOLD_MS
} from '@main/app/secondInstance'

describe('planSecondInstanceAction', () => {
  it('returns none when there is no window', () => {
    expect(planSecondInstanceAction({ hasWindow: false, unresponsiveForMs: null })).toEqual({
      action: 'none'
    })
    expect(planSecondInstanceAction({ hasWindow: false, unresponsiveForMs: 600_000 })).toEqual({
      action: 'none'
    })
  })

  it('returns focus when the renderer is responsive (null duration)', () => {
    expect(planSecondInstanceAction({ hasWindow: true, unresponsiveForMs: null })).toEqual({
      action: 'focus'
    })
  })

  it('returns focus below the unresponsive threshold', () => {
    expect(planSecondInstanceAction({ hasWindow: true, unresponsiveForMs: 0 })).toEqual({
      action: 'focus'
    })
    expect(planSecondInstanceAction({ hasWindow: true, unresponsiveForMs: 29_999 })).toEqual({
      action: 'focus'
    })
  })

  it('returns recreate-window at exactly the threshold', () => {
    expect(
      planSecondInstanceAction({
        hasWindow: true,
        unresponsiveForMs: SECOND_INSTANCE_UNRESPONSIVE_THRESHOLD_MS
      })
    ).toEqual({ action: 'recreate-window' })
  })

  it('returns recreate-window for long freezes', () => {
    expect(planSecondInstanceAction({ hasWindow: true, unresponsiveForMs: 600_000 })).toEqual({
      action: 'recreate-window'
    })
  })
})
