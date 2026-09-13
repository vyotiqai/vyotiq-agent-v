/**
 * The soft deadline must abort the tool it is timing out, not just abandon it.
 *
 * Regression: `raceToolDeadline` used to resolve the step and leave the
 * underlying work running ("keeps unwinding in the background"). A terminal
 * call that hit the deadline therefore kept its whole child process tree alive;
 * a wedged `vitest` went on competing with the retry that replaced it.
 *
 * The deadline is read once at module init, so the env override must be stubbed
 * and the module imported dynamically — ES import hoisting would otherwise run
 * the assignment after initialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/ipc'

const executeTool = vi.hoisted(() => vi.fn())

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

const DEADLINE_MS = 120

type StepCtx = {
  runId: string
  runDir: string
  workspace: string
  signal: AbortSignal
  runSignal: AbortSignal
  appendMessage: (msg: unknown) => void
  appendEvent: (ev: AgentEvent) => void
}

async function loadModule(): Promise<{
  executeStepToolCalls: (
    calls: { id: string; name: string; arguments: string }[],
    ctx: unknown,
    opts: { step: number }
  ) => Promise<{ messages: { content?: unknown }[]; stepToolsOk: boolean }>
  TOOL_SOFT_DEADLINE_MS: number
}> {
  vi.resetModules()
  vi.stubEnv('VYOTIQ_TOOL_SOFT_DEADLINE_MS', String(DEADLINE_MS))
  return (await import('@main/agent/executeStepTools')) as never
}

function makeCtx(signal: AbortSignal, runSignal: AbortSignal) {
  const events: AgentEvent[] = []
  const messages: { content?: unknown }[] = []
  return {
    ctx: {
      runId: 'run-1',
      runDir: '/tmp/run',
      workspace: '/tmp/ws',
      signal,
      runSignal,
      appendMessage: (msg: { content?: unknown }) => messages.push(msg),
      appendEvent: (ev: AgentEvent) => events.push(ev)
    } as unknown as StepCtx,
    events,
    messages
  }
}

describe('tool soft deadline', () => {
  beforeEach(() => {
    executeTool.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('honours the deadline override', async () => {
    const mod = await loadModule()
    expect(mod.TOOL_SOFT_DEADLINE_MS).toBe(DEADLINE_MS)
  })

  it('aborts the tool signal when the deadline expires', async () => {
    const mod = await loadModule()
    const run = new AbortController()
    const seen: AbortSignal[] = []
    // Never settles on its own — only the deadline can end this call.
    executeTool.mockImplementation(
      (_name: string, _args: string, _ws: string, signal: AbortSignal) => {
        seen.push(signal)
        return new Promise<never>(() => {})
      }
    )

    const { ctx, messages } = makeCtx(run.signal, run.signal)
    const outcome = await mod.executeStepToolCalls(
      [{ id: 'c1', name: 'terminal', arguments: '{"command":"sleep 999"}' }],
      ctx,
      { step: 1 }
    )

    expect(outcome.stepToolsOk).toBe(false)
    expect(String(messages[0]?.content)).toMatch(/exceeded its .*deadline/)

    // The signal handed to the tool is aborted, so handlers that own a process
    // (terminal tree-kill, background session dispose) release it instead of
    // leaking a live shell past the deadline.
    expect(seen[0]?.aborted).toBe(true)
    // The run signal drives the rest of the step and must survive.
    expect(run.signal.aborted).toBe(false)
  })

  it('does not abort a tool that finishes well before the deadline', async () => {
    const mod = await loadModule()
    const run = new AbortController()
    const seen: AbortSignal[] = []
    executeTool.mockImplementation(
      (_name: string, _args: string, _ws: string, signal: AbortSignal) => {
        seen.push(signal)
        return Promise.resolve({ ok: true, summary: 'done', content: 'ok' })
      }
    )
    const { ctx } = makeCtx(run.signal, run.signal)
    const outcome = await mod.executeStepToolCalls(
      [{ id: 'c1', name: 'terminal', arguments: '{"command":"echo hi"}' }],
      ctx,
      { step: 1 }
    )
    expect(outcome.stepToolsOk).toBe(true)
    expect(seen[0]?.aborted).toBe(false)
  })

  it('exempts ask_question from the deadline so a late human answer still succeeds', async () => {
    const mod = await loadModule()
    const run = new AbortController()
    const seen: AbortSignal[] = []
    // Resolves after the raced deadline would already have fired — exactly the
    // ask_question shape: the handler only settles when the human answers.
    executeTool.mockImplementation(
      (_name: string, _args: string, _ws: string, signal: AbortSignal) => {
        seen.push(signal)
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, summary: 'asked', content: 'The user answered: 42' }),
            DEADLINE_MS * 2
          )
        )
      }
    )
    const { ctx, messages } = makeCtx(run.signal, run.signal)
    const outcome = await mod.executeStepToolCalls(
      [{ id: 'c1', name: 'ask_question', arguments: '{"question":"Pick a number"}' }],
      ctx,
      { step: 1 }
    )

    expect(outcome.stepToolsOk).toBe(true)
    const content = String(messages[0]?.content)
    expect(content).not.toMatch(/exceeded its/)
    expect(content).toBe('The user answered: 42')
    // Waiting on the human must not abort the tool signal either — only the
    // run's own cancel does that.
    expect(seen[0]?.aborted).toBe(false)
    expect(run.signal.aborted).toBe(false)
  })
})
