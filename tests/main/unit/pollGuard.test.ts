import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@main/agent/providers/types'
import {
  POLL_HOLD_AFTER_ROUNDS,
  PollGuard,
  isRepollableCall,
  pollHoldNote,
  resultFingerprint,
  runPollHold,
  type PolledResult
} from '@main/agent/pollGuard'
import { createApprovalGate } from '@main/agent/toolApproval'

const SSH = 'ssh -p 2222 dev@127.0.0.1 "pgrep -f podman || echo idle"'

function frame(stdout: string, opts?: { status?: string; exit?: number; sessionId?: string }): string {
  return [
    `session_id: ${opts?.sessionId ?? crypto.randomUUID()}`,
    `status: ${opts?.status ?? 'done'}`,
    `command: ${SSH}`,
    'cwd: C:\\ws',
    'shell: powershell',
    '',
    stdout,
    `exit_code: ${opts?.exit ?? 0}`
  ].join('\n')
}

function sshCall(id: string, args?: Record<string, unknown>): ToolCall {
  return { id, name: 'terminal', arguments: JSON.stringify({ command: SSH, ...args }) }
}

function result(call: ToolCall, content: string, ok = true): PolledResult {
  return { toolCallId: call.id, name: call.name, ok, content }
}

/** A clock that only moves when the hold sleeps. */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    }
  }
}

describe('isRepollableCall', () => {
  it('takes foreground terminal commands and session polls', () => {
    expect(isRepollableCall(sshCall('a'))).toBe(true)
    expect(
      isRepollableCall({
        name: 'terminal',
        arguments: JSON.stringify({ session_id: '5d7c2b1e-0000-4000-8000-000000000000' })
      })
    ).toBe(true)
  })

  it('refuses a background start, which would add a copy on every re-run', () => {
    expect(isRepollableCall(sshCall('a', { block_until_ms: 0 }))).toBe(false)
  })

  it('refuses local reads: three identical reads are a lost model, not a wait', () => {
    expect(isRepollableCall({ name: 'read', arguments: '{"path":"a.ts"}' })).toBe(false)
    expect(isRepollableCall({ name: 'list_dir', arguments: '{"path":"src/tools"}' })).toBe(false)
    expect(isRepollableCall({ name: 'edit', arguments: '{"path":"a.ts"}' })).toBe(false)
  })
})

describe('resultFingerprint', () => {
  it('ignores the per-run session id', () => {
    const call = sshCall('a')
    expect(resultFingerprint(call, true, frame(''))).toBe(resultFingerprint(call, true, frame('')))
  })

  it('tells different output and exit codes apart', () => {
    const call = sshCall('a')
    const empty = resultFingerprint(call, true, frame(''))
    expect(resultFingerprint(call, true, frame('PULL_DONE'))).not.toBe(empty)
    expect(resultFingerprint(call, false, frame('', { exit: 255 }))).not.toBe(empty)
  })

  it('refuses a new command that is still running', () => {
    expect(resultFingerprint(sshCall('a'), true, frame('', { status: 'running', exit: -1 }))).toBeNull()
  })

  it('keeps a session poll that is still running, since polling it starts nothing', () => {
    const poll: ToolCall = {
      id: 'p',
      name: 'terminal',
      arguments: JSON.stringify({ session_id: '5d7c2b1e-0000-4000-8000-000000000000' })
    }
    expect(resultFingerprint(poll, true, frame('', { status: 'running', exit: -1 }))).not.toBeNull()
  })
})

describe('PollGuard', () => {
  it(`holds on round ${POLL_HOLD_AFTER_ROUNDS} of the same call with the same answer`, () => {
    const guard = new PollGuard()
    const verdicts = [1, 2, 3, 4].map((n) => {
      const call = sshCall(`c${n}`)
      return guard.observe([call], [result(call, frame(''))])
    })
    expect(verdicts).toEqual([false, false, true, true])
  })

  it('treats key order and whitespace in the arguments as the same call', () => {
    const guard = new PollGuard()
    const a: ToolCall = { id: 'a', name: 'terminal', arguments: `{"command":"${'x'}","timeoutMs":5000}` }
    const b: ToolCall = { id: 'b', name: 'terminal', arguments: `{ "timeoutMs": 5000, "command": "x" }` }
    const c: ToolCall = { id: 'c', name: 'terminal', arguments: `{"timeoutMs":5000,"command":"x"}` }
    expect(guard.observe([a], [result(a, frame(''))])).toBe(false)
    expect(guard.observe([b], [result(b, frame(''))])).toBe(false)
    expect(guard.observe([c], [result(c, frame(''))])).toBe(true)
  })

  it('starts over when the answer changes', () => {
    const guard = new PollGuard()
    const outputs = ['', '', '10%', '10%', '10%']
    const verdicts = outputs.map((out, n) => {
      const call = sshCall(`c${n}`)
      return guard.observe([call], [result(call, frame(out))])
    })
    expect(verdicts).toEqual([false, false, false, false, true])
  })

  it('never holds a repeated failure: that is a retry, and re-running a build costs a build', () => {
    const guard = new PollGuard()
    const verdicts = [1, 2, 3, 4].map((n) => {
      const call: ToolCall = { id: `f${n}`, name: 'terminal', arguments: '{"command":"cargo test"}' }
      return guard.observe([call], [result(call, frame('error: could not compile', { exit: 101 }), false)])
    })
    expect(verdicts).toEqual([false, false, false, false])
  })

  it('starts over when a step mixes in a call it cannot repeat', () => {
    const guard = new PollGuard()
    const step = (n: number, extra?: ToolCall): boolean => {
      const call = sshCall(`c${n}`)
      const calls = extra ? [call, extra] : [call]
      const results = calls.map((c) => result(c, c === call ? frame('') : 'body'))
      return guard.observe(calls, results)
    }
    expect(step(1)).toBe(false)
    expect(step(2)).toBe(false)
    expect(step(3, { id: 'r3', name: 'read', arguments: '{"path":"a.ts"}' })).toBe(false)
    expect(step(4)).toBe(false)
  })

  it('needs fresh rounds after a hold saw the answer change', () => {
    const guard = new PollGuard()
    for (let n = 1; n <= 3; n++) {
      const call = sshCall(`c${n}`)
      guard.observe([call], [result(call, frame(''))])
    }
    const held = sshCall('c3')
    guard.rebase([held], [result(held, frame('10%'))])
    const verdicts = [4, 5].map((n) => {
      const call = sshCall(`c${n}`)
      return guard.observe([call], [result(call, frame('10%'))])
    })
    expect(verdicts).toEqual([false, true])
  })
})

describe('runPollHold', () => {
  it('re-runs on a backoff and returns the first changed answer', async () => {
    const call = sshCall('c3')
    const clock = virtualClock()
    const answers = ['', '', 'PULL_DONE']
    let runs = 0
    const outcome = await runPollHold({
      calls: [call],
      baseline: [result(call, frame(''))],
      rerun: async () => ({ ok: true, content: frame(answers[runs++] ?? '') }),
      signal: new AbortController().signal,
      ...clock
    })
    expect(outcome.reason).toBe('changed')
    expect(outcome.checks).toBe(3)
    expect(outcome.elapsedMs).toBe(15_000 + 30_000 + 60_000)
    expect(outcome.results[0]!.content).toContain('PULL_DONE')
  })

  it('gives the call back when the budget runs out', async () => {
    const call = sshCall('c3')
    const clock = virtualClock()
    const outcome = await runPollHold({
      calls: [call],
      baseline: [result(call, frame(''))],
      rerun: async () => ({ ok: true, content: frame('') }),
      signal: new AbortController().signal,
      ...clock
    })
    expect(outcome.reason).toBe('budget')
    // 15s + 30s + 60s, then 2-minute waits, all inside 30 minutes.
    expect(outcome.checks).toBe(17)
    expect(outcome.elapsedMs).toBeLessThanOrEqual(30 * 60_000)
  })

  it('stops when the signal fires, without another re-run', async () => {
    const call = sshCall('c3')
    const controller = new AbortController()
    let runs = 0
    const outcome = await runPollHold({
      calls: [call],
      baseline: [result(call, frame(''))],
      rerun: async () => {
        runs++
        if (runs === 2) controller.abort()
        return { ok: true, content: frame('') }
      },
      signal: controller.signal,
      ...virtualClock()
    })
    expect(outcome.reason).toBe('interrupted')
    expect(runs).toBe(2)
    expect(outcome.checks).toBe(1)
  })

  it('reports a handler that throws as a changed, failed answer', async () => {
    const call = sshCall('c3')
    const outcome = await runPollHold({
      calls: [call],
      baseline: [result(call, frame(''))],
      rerun: async () => {
        throw new Error('spawn EPERM')
      },
      signal: new AbortController().signal,
      ...virtualClock()
    })
    expect(outcome.reason).toBe('changed')
    expect(outcome.results[0]).toMatchObject({ ok: false, content: 'spawn EPERM' })
  })
})

describe('pollHoldNote', () => {
  const call = sshCall('c3')

  it('carries the new answer when it changed', () => {
    const note = pollHoldNote([call], {
      reason: 'changed',
      checks: 8,
      elapsedMs: 13 * 60_000 + 45_000,
      results: [result(call, frame('PULL_DONE'))]
    })
    expect(note).toContain('8 re-checks over 13m 45s')
    expect(note).toContain('PULL_DONE')
  })

  it('says how to wait properly when nothing changed, without repeating the old answer', () => {
    const note = pollHoldNote([call], {
      reason: 'budget',
      checks: 17,
      elapsedMs: 30 * 60_000,
      results: [result(call, frame('still idle'))]
    })
    expect(note).toContain('has not changed')
    expect(note).toContain('block_until_ms')
    expect(note).not.toContain('still idle')
  })
})

describe('approval gate allowsWithoutAsking', () => {
  const base = { runId: 'r', workspaceAllowlist: [], signal: new AbortController().signal }
  const call = { name: 'terminal', arguments: JSON.stringify({ command: SSH }) }

  it('lets terminal through when approvals are off', async () => {
    const gate = createApprovalGate({ ...base, mode: 'off' })
    expect(await gate.allowsWithoutAsking!(call)).toBe(true)
  })

  it('refuses when every tool asks, and in autonomous mode, where terminal still asks', async () => {
    expect(await createApprovalGate({ ...base, mode: 'all' }).allowsWithoutAsking!(call)).toBe(false)
    const autonomous = createApprovalGate({ ...base, mode: 'all', autonomousMode: true })
    expect(await autonomous.allowsWithoutAsking!(call)).toBe(false)
  })

  it('asks nobody', async () => {
    let asked = 0
    const gate = createApprovalGate({
      ...base,
      mode: 'all',
      ask: async () => {
        asked++
        return 'once'
      }
    })
    await gate.allowsWithoutAsking!(call)
    expect(asked).toBe(0)
  })
})
