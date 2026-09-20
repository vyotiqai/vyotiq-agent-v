import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/ipc'

/**
 * The local runtime is the reference behavior every other substrate is compared
 * against. If this adapter reorders, filters, or synthesizes events, every
 * equivalence claim made about a cloud runtime later is measured against the
 * wrong baseline — so the wrapper is pinned here before any second runtime can
 * be registered.
 */

const GOLDEN: AgentEvent[] = [
  { type: 'status', runId: 'run-1', status: 'running' },
  { type: 'text_delta', runId: 'run-1', text: 'hello ' },
  { type: 'text_delta', runId: 'run-1', text: 'world' },
  {
    type: 'tool_call',
    runId: 'run-1',
    toolCallId: 't1',
    name: 'read',
    args: { path: 'a.ts' }
  },
  {
    type: 'tool_result',
    runId: 'run-1',
    toolCallId: 't1',
    name: 'read',
    ok: true,
    summary: 'a.ts',
    content: 'contents'
  },
  { type: 'assistant_message', runId: 'run-1', content: 'hello world' },
  { type: 'status', runId: 'run-1', status: 'done' }
] as AgentEvent[]

const runAgentMock = vi.hoisted(() =>
  vi.fn(async function* (): AsyncGenerator<AgentEvent> {
    for (const ev of GOLDEN) yield ev
  })
)
const cancelRunMock = vi.hoisted(() => vi.fn(() => true))
const enqueueFollowUpMock = vi.hoisted(() =>
  vi.fn(() => ({ ok: true as const, id: 'f1', position: 1, queueLength: 1 }))
)
const promoteFollowUpMock = vi.hoisted(() => vi.fn(() => ({ ok: true as const, queueLength: 1 })))

vi.mock('@main/agent/loop', () => ({ runAgent: runAgentMock }))
vi.mock('@main/agent/runRegistry', () => ({
  cancelRun: cancelRunMock,
  enqueueFollowUp: enqueueFollowUpMock,
  promoteFollowUp: promoteFollowUpMock
}))

import { localRuntime } from '@main/agent/runtimes/local'
import {
  getRuntime,
  isRuntimeRegistered,
  listRegisteredRuntimes,
  resolveAvailableRuntime
} from '@main/agent/runtimes'

const input = { runId: 'run-1', workspacePath: '/ws' }

describe('local runtime adapter', () => {
  beforeEach(() => {
    runAgentMock.mockClear()
    cancelRunMock.mockClear()
    enqueueFollowUpMock.mockClear()
    promoteFollowUpMock.mockClear()
  })

  it('yields the agent loop event sequence unchanged', async () => {
    const handle = localRuntime.start(input)
    const seen: AgentEvent[] = []
    for await (const ev of handle.events()) seen.push(ev)

    // Identical content AND identical order — a wrapper that merely produces
    // "the same kinds of events" would still break resume and transcript replay.
    expect(seen).toEqual(GOLDEN)
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(runAgentMock).toHaveBeenCalledWith(input)
  })

  it('declares what it can actually do', () => {
    expect(localRuntime.capabilities).toEqual({
      cancel: true,
      steer: true,
      // Nothing survives the process, so there is no session to reattach to.
      reconnect: false,
      approvals: true,
      questions: true
    })
  })

  it('cancels through the same path the Stop button uses', async () => {
    await localRuntime.start(input).cancel()
    expect(cancelRunMock).toHaveBeenCalledWith('run-1')
  })

  it('steers by queueing and promoting, not by passive enqueue', async () => {
    const message = { role: 'user' as const, content: 'do this instead' }
    await localRuntime.start(input).steer(message)
    expect(enqueueFollowUpMock).toHaveBeenCalledWith('run-1', message)
    // A passive enqueue would sit until the turn ended on its own, which is
    // not what "steer" promises.
    expect(promoteFollowUpMock).toHaveBeenCalledWith('run-1', 'f1')
  })

  it('refuses reconnect instead of pretending to restore a dead process', async () => {
    await expect(localRuntime.start(input).reconnect()).rejects.toThrow('no saved session')
  })

  it('does not cancel the run when the window merely stops listening', () => {
    localRuntime.start(input).dispose()
    // dispose() detaches; only cancel() stops work. Conflating them would kill
    // a runtime whose whole purpose is outliving the window.
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('persists a versioned record so status can be migrated later', () => {
    expect(localRuntime.start(input).record()).toEqual({ kind: 'local', version: 1 })
  })
})

describe('runtime registry', () => {
  it('ships local only until another runtime is implemented and tested', () => {
    expect(listRegisteredRuntimes()).toEqual(['local'])
    expect(isRuntimeRegistered('local')).toBe(true)
    expect(isRuntimeRegistered('cloud')).toBe(false)
  })

  it('fails loudly for an unregistered runtime rather than falling back', () => {
    expect(() => getRuntime('cloud')).toThrow('is not configured')
  })

  it('reports an unavailable runtime as an error, never as local', async () => {
    const resolved = await resolveAvailableRuntime('cloud')
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.error).toContain('cloud')
  })

  it('resolves local when it is available', async () => {
    const resolved = await resolveAvailableRuntime('local')
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.runtime.kind).toBe('local')
  })
})
