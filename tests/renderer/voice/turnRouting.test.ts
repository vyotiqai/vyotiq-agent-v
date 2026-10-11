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

describe('routing a voice turn', () => {
  it('starts or continues a task when the agent is idle', async () => {
    const t = target(false)
    await expect(routeVoiceTurn(turn('add a test'), t, 'steer')).resolves.toEqual({ kind: 'sent', runId: 'r1' })
    expect(t.calls).toEqual(['send:add a test:queue'])
  })

  it('steers a running task by default', async () => {
    const t = target(true)
    await routeVoiceTurn(turn('use the other file'), t, 'steer')
    expect(t.calls).toEqual(['send:use the other file:steer'])
  })

  it('stop-the-agent mode cancels, waits, then sends', async () => {
    const t = target(true)
    await routeVoiceTurn(turn('start over'), t, 'cancel')
    expect(t.calls).toEqual(['stop', 'send:start over:queue'])
  })

  it('just-stop-talking mode queues behind the run', async () => {
    const t = target(true)
    await routeVoiceTurn(turn('also check docs'), t, 'off')
    expect(t.calls).toEqual(['send:also check docs:queue'])
  })

  it('a stop phrase cancels a running task and never sends', async () => {
    const t = target(true)
    await expect(routeVoiceTurn(turn('stop', true), t, 'steer')).resolves.toEqual({ kind: 'stopped' })
    expect(t.calls).toEqual(['stop'])
    const idle = target(false)
    await expect(routeVoiceTurn(turn('never mind', true), idle, 'steer')).resolves.toEqual({ kind: 'dropped' })
    expect(idle.calls).toEqual([])
  })
})
