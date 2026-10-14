import { describe, expect, it, vi } from 'vitest'
import { routeVoiceTurn, type VoiceRunTarget } from '@renderer/features/voice/turnRouting'

function target(running: boolean): VoiceRunTarget & { calls: string[]; setRunning: (v: boolean) => void } {
  let isRunning = running
  const calls: string[] = []
  return {
    calls,
    setRunning: (v) => {
      isRunning = v
    },
    running: () => isRunning,
    runId: () => 'r1',
    send: vi.fn(async (text: string, opts: { steer: boolean }) => {
      calls.push(`send:${text}:${opts.steer ? 'steer' : 'queue'}`)
      return true
    }),
    stop: vi.fn(async () => {
      calls.push('stop')
      isRunning = false
    })
  }
}

const turn = (text: string, stop = false) => ({ turnId: 't', text, stop })

describe('routing the voice’s hand-off (D-44, D-46)', () => {
  it('starts or continues a task when the agent is idle', async () => {
    const t = target(false)
    await expect(routeVoiceTurn(turn('add a test'), t)).resolves.toEqual({ kind: 'sent', runId: 'r1' })
    expect(t.calls).toEqual(['send:add a test:queue'])
  })

  it('joins a running task mid-turn, and never stops it', async () => {
    const t = target(true)
    await routeVoiceTurn(turn('also check the docs'), t)
    expect(t.calls).toEqual(['send:also check the docs:steer'])
    expect(t.stop).not.toHaveBeenCalled()
  })

  it('a stop cancels a running task and never sends', async () => {
    const t = target(true)
    await expect(routeVoiceTurn(turn('stop', true), t)).resolves.toEqual({ kind: 'stopped' })
    expect(t.calls).toEqual(['stop'])
    const idle = target(false)
    await expect(routeVoiceTurn(turn('never mind', true), idle)).resolves.toEqual({ kind: 'dropped' })
    expect(idle.calls).toEqual([])
  })
})
