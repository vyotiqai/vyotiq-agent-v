import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentEvent } from '@shared/ipc'

const executeTool = vi.hoisted(() => vi.fn())

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { executeStepToolCalls, groupStepToolCalls } from '@main/agent/executeStepTools'

type TestCtx = Parameters<typeof executeStepToolCalls>[1]

function makeCtx(
  signal: AbortSignal,
  runSignal?: AbortSignal
) {
  const events: AgentEvent[] = []
  const messages: unknown[] = []
  return {
    ctx: {
      runId: 'run-1',
      runDir: '/tmp/run',
      workspace: '/tmp/ws',
      signal,
      runSignal,
      appendMessage: (msg: unknown) => messages.push(msg),
      appendEvent: (ev: AgentEvent) => events.push(ev)
    } as unknown as TestCtx,
    events,
    messages
  }
}

function combinedSignal(runSignal: AbortSignal, softSignal: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([runSignal, softSignal])
  }
  return runSignal
}

describe('executeStepToolCalls', () => {
  beforeEach(() => {
    executeTool.mockReset()
  })

  it('preserves tool result order for parallel read-only calls', async () => {
    executeTool.mockImplementation(async (name: string) => {
      return { ok: true, summary: name, content: `body:${name}` }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'search', arguments: '{"query":"foo"}' }
      ],
      ctx
    )

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    expect(outcome.messages.map((m) => m.content)).toEqual(['body:read', 'body:read', 'body:search'])
    expect(outcome.stepToolsOk).toBe(true)
  })

  it('synthesizes ids for empty tool call ids instead of failing malformed', async () => {
    executeTool.mockImplementation(async (name: string) => {
      return { ok: true, summary: name, content: `ok:${name}` }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: '', name: 'grep', arguments: '{"pattern":"foo"}' },
        { id: '  ', name: 'read', arguments: '{"path":"a.ts"}' }
      ],
      ctx
    )

    expect(outcome.stepToolsOk).toBe(true)
    expect(outcome.messages).toHaveLength(2)
    expect(outcome.messages[0]?.toolCallId?.trim()).toBeTruthy()
    expect(outcome.messages[1]?.toolCallId?.trim()).toBeTruthy()
    expect(outcome.messages[0]?.toolCallId).not.toBe(outcome.messages[1]?.toolCallId)
    expect(outcome.messages.map((m) => m.content)).toEqual(['ok:grep', 'ok:read'])
    expect(executeTool).toHaveBeenCalledTimes(2)
  })

  it('runs mutating tools after read-only batches in call order', async () => {
    const order: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      order.push(name)
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    expect(order).toEqual(['read', 'edit', 'read'])
  })

  describe('re-read soft note', () => {
    function makeCtxWithReads() {
      const { ctx } = makeCtx(new AbortController().signal)
      const recentReadPaths = new Map<string, number>([['a.ts', 10]])
      const withReads = {
        ...ctx,
        recentReadPaths,
        readStampStep: 11
      } as unknown as TestCtx
      return { ctx: withReads, recentReadPaths }
    }

    it('appends a note when a full-file read repeats within the stale window', async () => {
      executeTool.mockImplementation(async () => ({
        ok: true,
        summary: 'read',
        content: 'file body'
      }))
      const { ctx } = makeCtxWithReads()
      const outcome = await executeStepToolCalls(
        [{ id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' }],
        ctx
      )
      expect(outcome.messages[0]?.content).toContain('[Note: a.ts was already read 1 step ago')
      expect(outcome.messages[0]?.content).toContain('file body')
    })

    it('does not note first-time, ranged, or stale reads', async () => {
      executeTool.mockImplementation(async () => ({
        ok: true,
        summary: 'read',
        content: 'file body'
      }))
      const { ctx, recentReadPaths } = makeCtxWithReads()
      recentReadPaths.set('ranged.ts', 10)
      recentReadPaths.set('old.ts', 3)
      const outcome = await executeStepToolCalls(
        [
          { id: 'r1', name: 'read', arguments: '{"path":"new.ts"}' },
          { id: 'r2', name: 'read', arguments: '{"path":"ranged.ts","startLine":1,"endLine":5}' },
          { id: 'r3', name: 'read', arguments: '{"path":"old.ts"}' }
        ],
        ctx
      )
      for (const msg of outcome.messages) {
        expect(msg.content).not.toContain('[Note:')
      }
    })

    it('records fresh reads and drops them after a successful mutation', async () => {
      executeTool.mockImplementation(async () => ({
        ok: true,
        summary: 'read',
        content: 'file body'
      }))
      const { ctx, recentReadPaths } = makeCtxWithReads()
      await executeStepToolCalls(
        [{ id: 'r1', name: 'read', arguments: '{"path":"fresh.ts"}' }],
        ctx
      )
      expect(recentReadPaths.get('fresh.ts')).toBe(11)
      await executeStepToolCalls(
        [{ id: 'e1', name: 'edit', arguments: '{"path":"fresh.ts","contents":"next"}' }],
        ctx
      )
      expect(recentReadPaths.has('fresh.ts')).toBe(false)
    })
  })

  it('remaps invented Write onto edit before dispatch', async () => {
    executeTool.mockImplementation(async (name: string) => {
      return { ok: true, summary: name, content: `ok:${name}` }
    })

    const { ctx, events } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [{ id: 'w1', name: 'Write', arguments: '{"path":"a.ts","contents":"x"}' }],
      ctx
    )

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(executeTool.mock.calls[0]?.[0]).toBe('edit')
    expect(outcome.messages[0]?.toolName).toBe('edit')
    const start = events.find((ev) => ev.type === 'tool_start')
    expect(start && start.type === 'tool_start' ? start.name : undefined).toBe('edit')
  })

  it('marks soft-aborted in-flight tools Interrupted while run cancel stays Cancelled', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    const signal = combinedSignal(runAc.signal, softAc.signal)

    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal) => {
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx } = makeCtx(signal, runAc.signal)
    const work = executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )
    softAc.abort()
    const outcome = await work

    expect(outcome.stepToolsOk).toBe(false)
    expect(outcome.messages[0]?.content).toBe('Interrupted')
    expect(outcome.messages[0]?.toolCallId).toBe('c1')
  })

  it('marks run-cancelled tools as Cancelled when runSignal aborts', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    const signal = combinedSignal(runAc.signal, softAc.signal)

    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal) => {
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx } = makeCtx(signal, runAc.signal)
    const work = executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )
    runAc.abort()
    const outcome = await work

    expect(outcome.stepToolsOk).toBe(false)
    expect(outcome.messages[0]?.content).toBe('Cancelled')
  })

  it('marks pending parallel read tools cancelled when aborted mid-batch', async () => {
    const ac = new AbortController()
    let started = 0
    executeTool.mockImplementation(async () => {
      started += 1
      if (started === 1) {
        ac.abort()
        await new Promise((r) => setTimeout(r, 20))
      }
      return { ok: true, summary: 'file', content: 'ok' }
    })

    const { ctx } = makeCtx(ac.signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"c.ts"}' }
      ],
      ctx
    )

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    // At least one tool never started or was interrupted after abort.
    const cancelled = outcome.messages.filter((m) => m.content === 'Cancelled')
    expect(cancelled.length).toBeGreaterThanOrEqual(1)
  })

  it('preserves completed parallel successes after abort and cancels only unfinished tools', async () => {
    const ac = new AbortController()
    let started = 0
    executeTool.mockImplementation(async () => {
      started += 1
      if (started === 1) {
        // Finish successfully before abort is observed by the other worker.
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true, summary: 'early', content: 'completed-ok' }
      }
      ac.abort()
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, summary: 'late', content: 'also-finished' }
    })

    const { ctx, events } = makeCtx(ac.signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    // Settled ToolOutcomes are kept (including late finishes that returned ok).
    expect(outcome.messages.every((m) => m.content === 'Cancelled')).toBe(false)
    expect(outcome.messages.some((m) => m.content === 'completed-ok' || m.content === 'also-finished')).toBe(
      true
    )
    // No duplicate tool_start for the same toolCallId.
    const starts = events.filter((e) => e.type === 'tool_start')
    const startIds = starts.map((e) => (e.type === 'tool_start' ? e.toolCallId : ''))
    expect(startIds.length).toBe(new Set(startIds).size)
  })

  it('does not re-emit tool_start when synthesizing abort for in-flight parallel tools', async () => {
    const ac = new AbortController()
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal: AbortSignal) => {
      releaseFirst()
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx, events } = makeCtx(ac.signal)
    const calls = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i + 1}`,
      name: 'read',
      arguments: `{"path":"${i}.ts"}`
    }))
    const work = executeStepToolCalls(calls, ctx)
    await firstStarted
    ac.abort()
    const outcome = await work

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(calls.map((c) => c.id))
    expect(outcome.messages.some((m) => m.content === 'Cancelled')).toBe(true)
    const startsById = new Map<string, number>()
    for (const ev of events) {
      if (ev.type !== 'tool_start') continue
      startsById.set(ev.toolCallId, (startsById.get(ev.toolCallId) ?? 0) + 1)
    }
    expect(startsById.size).toBe(calls.length)
    for (const count of startsById.values()) {
      expect(count).toBe(1)
    }
  })

  it('does not inject recipe text on repeated tool failures', async () => {
    executeTool.mockResolvedValue({
      ok: false,
      summary: 'core/build.gradle.kts',
      content: 'File not found: core/build.gradle.kts',
      failureLogged: true
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const call = { id: 'c1', name: 'read', arguments: '{"path":"core/build.gradle.kts"}' }

    await executeStepToolCalls([call], ctx)
    const second = await executeStepToolCalls([call], ctx)

    expect(second.messages[0]?.content).toMatch(/File not found/)
    expect(String(second.messages[0]?.content)).not.toMatch(/Repeated failure|stop guessing/i)
  })

  it('feeds a denied approval back as a tool failure without running the tool', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'edit', content: 'wrote' })

    const { ctx, events } = makeCtx(new AbortController().signal)
    ctx.approval = {
      authorize: async () => ({ allowed: false, reason: 'The user denied permission to run edit.' })
    }
    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' }],
      ctx
    )

    expect(executeTool).not.toHaveBeenCalled()
    expect(outcome.stepToolsOk).toBe(false)
    expect(outcome.messages[0]?.content).toMatch(/denied permission/)
    expect(outcome.messages[0]?.ok).toBe(false)
    const result = events.find((ev) => ev.type === 'tool_result')
    expect(result).toMatchObject({ type: 'tool_result', summary: 'a.ts', ok: false })
  })

  it('emits tool_start live and persists ok on tool messages', async () => {
    const live: AgentEvent[] = []
    executeTool.mockResolvedValue({ ok: false, summary: 'file', content: 'permission denied' })

    const { ctx, events } = makeCtx(new AbortController().signal)
    ctx.emitLiveEvent = (ev) => live.push(ev)
    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )

    expect(live.some((ev) => ev.type === 'tool_start' && ev.toolCallId === 'c1')).toBe(true)
    expect(live.some((ev) => ev.type === 'tool_result' && ev.toolCallId === 'c1')).toBe(true)
    expect(events.some((ev) => ev.type === 'tool_start' && ev.toolCallId === 'c1')).toBe(true)
    expect(outcome.messages[0]?.ok).toBe(false)
  })

  it('emits the live tool_result before waiting on message persist', async () => {
    const order: string[] = []
    executeTool.mockResolvedValue({ ok: true, summary: 'big', content: 'full output' })
    const { ctx } = makeCtx(new AbortController().signal)
    ctx.appendMessage = async () => {
      await Promise.resolve()
      order.push('persisted')
    }
    ctx.emitLiveEvent = (event) => {
      if (event.type === 'tool_result') order.push('emitted')
    }

    await executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )

    expect(order).toEqual(['emitted', 'persisted'])
  })

  it('stops later serial tools when appendMessage rejects (persist failure)', async () => {
    const ran: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      ran.push(name)
      return { ok: true, summary: name, content: name }
    })
    const { ctx } = makeCtx(new AbortController().signal)
    let appends = 0
    ctx.appendMessage = async () => {
      appends++
      if (appends === 1) throw new Error('disk full')
    }

    await expect(
      executeStepToolCalls(
        [
          { id: 'c1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
          { id: 'c2', name: 'edit', arguments: '{"path":"a.ts","contents":"y"}' }
        ],
        ctx
      )
    ).rejects.toThrow('disk full')

    expect(ran).toEqual(['edit'])
    expect(appends).toBe(1)
  })





  it('persists parallel read results in call order, not settle order', async () => {
    executeTool.mockImplementation(async (_name: string, args: string) => {
      const path = String((JSON.parse(args) as { path: string }).path)
      // b.ts settles first; the transcript must still list a.ts first.
      await new Promise((r) => setTimeout(r, path === 'a.ts' ? 25 : 1))
      return { ok: true, summary: path, content: path }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2'])
    expect(outcome.messages.map((m) => m.content)).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps parallel reads when an approval gate is present', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let authorizeCalls = 0

    executeTool.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 15))
      concurrent -= 1
      return { ok: true, summary: 'file', content: 'ok' }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.approval = {
      authorize: async () => {
        authorizeCalls += 1
        return { allowed: true }
      }
    }

    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' },
        { id: 'c3', name: 'read', arguments: '{"path":"c.ts"}' }
      ],
      ctx
    )

    // Approval gates each tool; read-only batches still run in parallel.
    expect(authorizeCalls).toBe(3)
    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('serializes gated browser_search calls when an approval gate is present', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let authorizeOverlapping = 0
    let authorizeInFlight = 0

    executeTool.mockImplementation(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: 'ok', content: 'body' }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.approval = {
      authorize: async () => {
        authorizeInFlight += 1
        authorizeOverlapping = Math.max(authorizeOverlapping, authorizeInFlight)
        await new Promise((r) => setTimeout(r, 15))
        authorizeInFlight -= 1
        return { allowed: true }
      }
    }

    await executeStepToolCalls(
      [
        { id: 'f1', name: 'browser_search', arguments: '{"query":"vyotiq a"}' },
        { id: 'f2', name: 'browser_search', arguments: '{"query":"vyotiq b"}' },
        { id: 's1', name: 'browser_navigate', arguments: '{"url":"https://example.com"}' }
      ],
      ctx
    )

    expect(authorizeOverlapping).toBe(1)
    expect(maxConcurrent).toBe(1)
  })

  it('emits tool_result live for each parallel tool as it finishes', async () => {
    const live: AgentEvent[] = []
    const finished: string[] = []

    executeTool.mockImplementation(async (_name: string, args: string) => {
      const path = JSON.parse(args).path as string
      if (path === 'b.ts') await new Promise((r) => setTimeout(r, 40))
      else await new Promise((r) => setTimeout(r, 5))
      finished.push(path)
      return { ok: true, summary: path, content: `body:${path}` }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.emitLiveEvent = (ev) => {
      if (ev.type === 'tool_result') live.push(ev)
    }

    await executeStepToolCalls(
      [
        { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )

    expect(live.map((ev) => (ev.type === 'tool_result' ? ev.toolCallId : ''))).toEqual(['c1', 'c2'])
    expect(finished.indexOf('a.ts')).toBeLessThan(finished.indexOf('b.ts'))
  })

  it('soft-warns when editing an existing file never inspected in knownPaths', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-known-paths-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), ' const x = 1\n', 'utf8')

    executeTool.mockResolvedValue({ ok: true, summary: 'edited', content: 'ok' })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.workspace = dir
    ctx.knownPaths = new Set()
    ctx.diagnosticsCommand = 'echo diagnostics'

    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'edit', arguments: '{"path":"src/a.ts","contents":"x"}' }],
      ctx
    )

    expect(outcome.messages[0]?.content).toContain(
      'Soft warning: edited existing file(s) without a prior read/grep/glob/codebase_search inspect: src/a.ts'
    )
    expect(outcome.messages[0]?.content).toContain('mutated file(s) without calling diagnostics')
  })

  it('soft-warns on file mutation without diagnostics in the same step', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'edited', content: 'ok' })
    const { ctx } = makeCtx(new AbortController().signal)
    ctx.diagnosticsCommand = 'echo diagnostics'
    const outcome = await executeStepToolCalls(
      [{ id: 'c1', name: 'str_replace', arguments: '{"path":"new.ts","old_string":"a","new_string":"b"}' }],
      ctx
    )
    expect(outcome.messages[0]?.content).toContain('mutated file(s) without calling diagnostics')
  })

  it('forwards runSignal into tool execution context for nested abort semantics', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    executeTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    const { ctx } = makeCtx(combinedSignal(runAc.signal, softAc.signal), runAc.signal)
    await executeStepToolCalls(
      [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
      ctx
    )
    expect(executeTool.mock.calls[0]?.[4]).toMatchObject({ runSignal: runAc.signal })
  })

  it('soft-warns after delete clears prior inspect so recreate-edit is unread', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, unlinkSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-delete-known-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const x = 1\n', 'utf8')

    executeTool.mockImplementation(async (name: string) => {
      if (name === 'delete') {
        unlinkSync(join(dir, 'src', 'a.ts'))
        return { ok: true, summary: 'deleted', content: 'ok' }
      }
      return { ok: true, summary: name, content: 'ok' }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.workspace = dir
    ctx.knownPaths = new Set(['src/a.ts'])

    await executeStepToolCalls(
      [{ id: 'd1', name: 'delete', arguments: '{"path":"src/a.ts"}' }],
      ctx
    )
    expect(ctx.knownPaths.has('src/a.ts')).toBe(false)

    // File reappears (user/other tool) without a new inspect.
    writeFileSync(join(dir, 'src', 'a.ts'), 'const x = 2\n', 'utf8')

    const outcome = await executeStepToolCalls(
      [{ id: 'e1', name: 'edit', arguments: '{"path":"src/a.ts","contents":"x"}' }],
      ctx
    )
    expect(outcome.messages[0]?.content).toContain(
      'Soft warning: edited existing file(s) without a prior read/grep/glob/codebase_search inspect: src/a.ts'
    )
  })

  it('skips diagnostics soft-nudge when diagnostics is in the same step', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'c1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'c2', name: 'diagnostics', arguments: '{}' }
      ],
      ctx
    )
    const editMsg = outcome.messages.find((m) => m.toolCallId === 'c1')
    expect(editMsg?.content).not.toContain('mutated file(s) without calling diagnostics')
  })

  it('passes JSON array tool args through to executeTool', async () => {
    executeTool.mockResolvedValue({ ok: false, summary: 'edit', content: 'path required' })
    const raw = '[{"path":"a.ts","contents":"x"}]'
    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls([{ id: 'c1', name: 'edit', arguments: raw }], ctx)
    expect(executeTool).toHaveBeenCalledWith(
      'edit',
      raw,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('passes ask_question array args through without wrapping', async () => {
    executeTool.mockResolvedValue({ ok: true, summary: 'asked', content: 'ok' })
    const raw =
      '[{"id":"q1","prompt":"Pick?","type":"single","options":["A","B"]}]'
    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [{ id: 'c1', name: 'ask_question', arguments: raw }],
      ctx
    )
    expect(executeTool).toHaveBeenCalledWith(
      'ask_question',
      raw,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('overlaps edit on different files', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'e1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'e2', name: 'edit', arguments: '{"path":"b.ts","contents":"y"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBeGreaterThan(1)
    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['e1', 'e2'])
  })

  it('overlaps str_replace on different files', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 's1', name: 'str_replace', arguments: '{"path":"a.ts","old_string":"a","new_string":"b"}' },
        { id: 's2', name: 'str_replace', arguments: '{"path":"b.ts","old_string":"c","new_string":"d"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('serializes edit on the same file', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 'e1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'e2', name: 'edit', arguments: '{"path":"a.ts","contents":"y"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBe(1)
  })

  it('overlaps edit_notebook on different notebooks', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 'n1', name: 'edit_notebook', arguments: '{"target_notebook":"a.ipynb"}' },
        { id: 'n2', name: 'edit_notebook', arguments: '{"target_notebook":"b.ipynb"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('serializes edit_notebook on the same notebook', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 'n1', name: 'edit_notebook', arguments: '{"target_notebook":"a.ipynb"}' },
        { id: 'n2', name: 'edit_notebook', arguments: '{"target_notebook":"a.ipynb"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBe(1)
  })

  it('overlaps memory_write on disjoint memory paths', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 'm1', name: 'memory_write', arguments: '{"path":"notes/a.md","contents":"a"}' },
        { id: 'm2', name: 'memory_write', arguments: '{"path":"notes/b.md","contents":"b"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBeGreaterThan(1)
  })

  it('overlaps spawn_agent_instance in one step without starting child LLMs', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: `spawned:${name}` }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'sp1', name: 'spawn_agent_instance', arguments: '{"goal":"workstream a"}' },
        { id: 'sp2', name: 'spawn_agent_instance', arguments: '{"goal":"workstream b"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBeGreaterThan(1)
    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['sp1', 'sp2'])
  })

  it('overlaps await_agent_instance in one step', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    executeTool.mockImplementation(async (name: string) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    const outcome = await executeStepToolCalls(
      [
        { id: 'a1', name: 'await_agent_instance', arguments: '{"run_id":"child-a"}' },
        { id: 'a2', name: 'await_agent_instance', arguments: '{"run_id":"child-b"}' }
      ],
      ctx
    )

    expect(maxConcurrent).toBeGreaterThan(1)
    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['a1', 'a2'])
  })

  it('returns an abort result per id for a parallel mutation batch', async () => {
    const ac = new AbortController()
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    executeTool.mockImplementation(async (_name, _args, _ws, toolSignal: AbortSignal) => {
      releaseFirst()
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const { ctx } = makeCtx(ac.signal)
    const calls = [
      { id: 'e1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
      { id: 'e2', name: 'edit', arguments: '{"path":"b.ts","contents":"y"}' }
    ]
    const work = executeStepToolCalls(calls, ctx)
    await firstStarted
    ac.abort()
    const outcome = await work

    expect(outcome.messages.map((m) => m.toolCallId)).toEqual(['e1', 'e2'])
    expect(outcome.messages).toHaveLength(2)
    expect(outcome.messages.every((m) => m.content === 'Cancelled' || m.content === 'Interrupted')).toBe(
      true
    )
  })

  it('hoists todo_write ahead of the rest of the step in Agent mode', async () => {
    const order: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      order.push(name)
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.agentMode = 'agent'
    await executeStepToolCalls(
      [
        { id: 'e1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
        { id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
        {
          id: 't1',
          name: 'todo_write',
          arguments: '{"todos":[{"id":"1","content":"Edit a.ts","status":"in_progress"}]}'
        }
      ],
      ctx
    )

    expect(order).toEqual(['todo_write', 'edit', 'read'])
  })

  it('does not hoist todo_write in Plan mode', async () => {
    const order: string[] = []
    executeTool.mockImplementation(async (name: string) => {
      order.push(name)
      return { ok: true, summary: name, content: name }
    })

    const { ctx } = makeCtx(new AbortController().signal)
    ctx.agentMode = 'plan'
    await executeStepToolCalls(
      [
        { id: 'e1', name: 'edit', arguments: '{"path":"plan.md","contents":"# Plan\\n"}' },
        { id: 'r1', name: 'read', arguments: '{"path":"plan.md"}' },
        {
          id: 't1',
          name: 'todo_write',
          arguments: '{"todos":[{"id":"1","content":"Draft plan.md","status":"in_progress"}]}'
        }
      ],
      ctx
    )

    expect(order).toEqual(['edit', 'read', 'todo_write'])
  })
})

describe('groupStepToolCalls', () => {
  it('batches disjoint edits and splits the same path', () => {
    const disjoint = groupStepToolCalls([
      { id: 'e1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
      { id: 'e2', name: 'edit', arguments: '{"path":"b.ts","contents":"y"}' }
    ])
    expect(disjoint.map((g) => g.map((c) => c.id))).toEqual([['e1', 'e2']])

    const samePath = groupStepToolCalls([
      { id: 'e1', name: 'edit', arguments: '{"path":"a.ts","contents":"x"}' },
      { id: 'e2', name: 'edit', arguments: '{"path":"a.ts","contents":"y"}' }
    ])
    expect(samePath.map((g) => g.map((c) => c.id))).toEqual([['e1'], ['e2']])
  })

  it('batches consecutive spawns then consecutive awaits without reordering', () => {
    const batched = groupStepToolCalls([
      { id: 'sp1', name: 'spawn_agent_instance', arguments: '{"goal":"a"}' },
      { id: 'sp2', name: 'spawn_agent_instance', arguments: '{"goal":"b"}' },
      { id: 'a1', name: 'await_agent_instance', arguments: '{"run_id":"child-a"}' },
      { id: 'a2', name: 'await_agent_instance', arguments: '{"run_id":"child-b"}' }
    ])
    expect(batched.map((g) => g.map((c) => c.id))).toEqual([
      ['sp1', 'sp2'],
      ['a1', 'a2']
    ])

    const interleaved = groupStepToolCalls([
      { id: 'sp1', name: 'spawn_agent_instance', arguments: '{"goal":"a"}' },
      { id: 'a1', name: 'await_agent_instance', arguments: '{"run_id":"child-a"}' },
      { id: 'sp2', name: 'spawn_agent_instance', arguments: '{"goal":"b"}' },
      { id: 'a2', name: 'await_agent_instance', arguments: '{"run_id":"child-b"}' }
    ])
    expect(interleaved.map((g) => g.map((c) => c.id))).toEqual([['sp1'], ['a1'], ['sp2'], ['a2']])
  })

  it('yields to the event loop between serial tools and after parallel batches', async () => {
    const walk = await import('@main/agent/tools/walk')
    const spy = vi.spyOn(walk, 'yieldToEventLoop')
    executeTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [
        { id: 't1', name: 'todo_write', arguments: '{"todos":[]}' },
        { id: 't2', name: 'todo_write', arguments: '{"todos":[]}' },
        { id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'r2', name: 'read', arguments: '{"path":"b.ts"}' }
      ],
      ctx
    )
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)
    spy.mockRestore()
  })

  it('logs the real error line (not the args summary) when a tool fails', async () => {
    const { logger } = await import('@shared/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    executeTool.mockResolvedValue({
      ok: false,
      summary: '2 tasks',
      content: 'todos.0.content: Required; todos.1.content: Required'
    })
    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [{ id: 't1', name: 'todo_write', arguments: '{"todos":[{},{}]}' }],
      ctx
    )
    const failLog = warnSpy.mock.calls.find(([msg]) => msg === 'Tool returned failure')
    expect(failLog).toBeDefined()
    const fields = failLog?.[1] as { tool: string; reason?: string }
    expect(fields.tool).toBe('todo_write')
    expect(fields.reason).toBe('todos.0.content: Required; todos.1.content: Required')
    warnSpy.mockRestore()
  })

  it('bounds a multi-line failure log to its first line and falls back to summary', async () => {
    const { logger } = await import('@shared/logger')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    executeTool.mockResolvedValue({
      ok: false,
      summary: 'cmd',
      content: 'first line\nsecond line\nthird line'
    })
    const { ctx } = makeCtx(new AbortController().signal)
    await executeStepToolCalls(
      [{ id: 'x1', name: 'terminal', arguments: '{"command":"false"}' }],
      ctx
    )
    const failLog = warnSpy.mock.calls.find(([msg]) => msg === 'Tool returned failure')
    const fields = failLog?.[1] as { reason?: string }
    expect(fields.reason).toBe('first line')
    warnSpy.mockRestore()
  })
})
