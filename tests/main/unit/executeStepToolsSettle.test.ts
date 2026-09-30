import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentEvent } from '@shared/ipc'

const executeTool = vi.hoisted(() => vi.fn())

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { executeStepToolCalls } from '@main/agent/executeStepTools'

type TestCtx = Parameters<typeof executeStepToolCalls>[1]

/**
 * A batch that throws used to lose every sibling that had already written to
 * disk: `runParallelBatch` rethrew the first error before the caller persisted
 * the settled outcomes, so a `git_commit` later in the run staged nothing and
 * the receipt showed no writes. These lock the fix in: the settled siblings are
 * persisted, and the error still propagates so the run ends exactly as before.
 */
function makeCtx(signal: AbortSignal, extra?: Partial<TestCtx>) {
  const events: AgentEvent[] = []
  const messages: unknown[] = []
  const ctx = {
    runId: 'run-settle',
    runDir: '/tmp/run-settle',
    workspace: '/tmp/ws-settle',
    signal,
    appendMessage: (msg: unknown) => {
      messages.push(msg)
    },
    appendEvent: (ev: AgentEvent) => {
      events.push(ev)
    },
    ...extra
  } as unknown as TestCtx
  return { ctx, events, messages }
}

const persistedResults = (events: AgentEvent[]): string[] =>
  events.filter((ev) => ev.type === 'tool_result').map((ev) => ev.toolCallId)

describe('parallel batch: settled siblings survive a thrown tool', () => {
  beforeEach(() => {
    executeTool.mockReset()
  })

  it('persists every settled read sibling, then propagates the thrown tool error', async () => {
    executeTool.mockImplementation(async (name: string, args: string) => {
      const path = String((JSON.parse(args) as { path: string }).path)
      // The middle call fails only after both siblings have settled, so the
      // batch is guaranteed to hold real results when the error arrives.
      if (path === 'b.ts') {
        await new Promise((r) => setTimeout(r, 25))
        throw new Error('read handler exploded')
      }
      return { ok: true, summary: name, content: `body:${path}` }
    })

    const { ctx, events, messages } = makeCtx(new AbortController().signal)

    await expect(
      executeStepToolCalls(
        [
          { id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'r2', name: 'read', arguments: '{"path":"b.ts"}' },
          { id: 'r3', name: 'read', arguments: '{"path":"c.ts"}' }
        ],
        ctx
      )
    ).rejects.toThrow('read handler exploded')

    // Both settled siblings reached disk: the tool message (the provider sees
    // it) and the persisted tool_result event (the receipt reads it).
    expect(messages).toHaveLength(2)
    expect(persistedResults(events)).toEqual(['r1', 'r3'])
    // The thrown call itself is not fabricated into a result.
    expect(persistedResults(events)).not.toContain('r2')
  })

  it('records a settled mutation sibling in mutationPaths (git_commit staging) and persists it', async () => {
    executeTool.mockImplementation(async (name: string, args: string) => {
      const path = String((JSON.parse(args) as { path: string }).path)
      if (path === 'src/b.ts') {
        await new Promise((r) => setTimeout(r, 25))
        throw new Error('edit handler exploded')
      }
      return { ok: true, summary: name, content: `wrote:${path}` }
    })

    const mutationPaths = new Set<string>()
    const { ctx, events, messages } = makeCtx(new AbortController().signal, {
      mutationPaths
    })

    await expect(
      executeStepToolCalls(
        [
          { id: 'm1', name: 'edit', arguments: '{"path":"src/a.ts","contents":"x"}' },
          { id: 'm2', name: 'edit', arguments: '{"path":"src/b.ts","contents":"y"}' },
          { id: 'm3', name: 'edit', arguments: '{"path":"src/c.ts","contents":"z"}' }
        ],
        ctx
      )
    ).rejects.toThrow('edit handler exploded')

    // git_commit stages from mutationPaths, so the sibling that wrote to disk
    // must still be in scope even though its batch failed.
    expect([...mutationPaths]).toEqual(['src/a.ts', 'src/c.ts'])
    expect(messages).toHaveLength(2)
    expect(persistedResults(events)).toEqual(['m1', 'm3'])
  })
})
