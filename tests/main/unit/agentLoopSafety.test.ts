import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-loopsafety-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: vi.fn(async () => {}),
    listMcpToolDefinitions: () => []
  }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { streamChat, executeTool, assembleContext } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  assembleContext: vi.fn(async (input: { messages: unknown[] }) => ({
    messages: input.messages,
    system: 'system',
    estimatedTokens: 100,
    layers: { system: 10, history: 50, tools: 20, buffer: 20 },
    overflow: false,
    anthropicNative: undefined,
    compaction: null
  }))
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (...args: unknown[]) => assembleContext(...args),
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'ollama', listModels: async () => [], streamChat }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { runAgent } from '@main/agent/loop'
import { enqueueFollowUp, resetActiveRunsForTests } from '@main/agent/runRegistry'

type CapturedEvent = {
  type: string
  status?: string
  code?: string
  message?: string
  ids?: string[]
  reason?: string
}

async function collect(
  runId: string,
  workspace: string,
  opts?: { resume?: boolean }
): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'keep using tools' }],
    workspacePath: workspace,
    ...(opts?.resume ? { resume: true } : {})
  })) {
    events.push(ev as CapturedEvent)
  }
  return events
}

function expectNoLoopSafetyStop(events: CapturedEvent[]): void {
  expect(events.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
  expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(false)
  expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
}

describe('runAgent loop continuation integration', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-loopsafety-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('continues after the same tool call repeats many steps in a row', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > 5) {
        yield { type: 'text', text: 'finished after repeating tools' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `c${call}`, name: 'read', arguments: '{"path":"a.ts"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-identical-streak'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(6)
    expect(executeTool).toHaveBeenCalledTimes(5)
    expectNoLoopSafetyStop(events)

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).not.toContain('"code":"LOOP_SAFETY"')
  })

  it('auto-continues truncated text then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call <= 3) {
        yield { type: 'text', text: 'partial…' }
        yield { type: 'done', stopReason: 'length' }
        return
      }
      yield { type: 'text', text: 'complete' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-identical-reset'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(4)
    expectNoLoopSafetyStop(events)
    expect(events.some((e) => e.type === 'incomplete' && e.reason === 'truncated')).toBe(true)
  })

  it('does not drop queued follow-ups on a repeating tool streak', async () => {
    const runId = 'safety-follow-up-dropped'
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 3) {
        const queued = enqueueFollowUp(runId, { role: 'user', content: 'late steer' })
        expect(queued.ok).toBe(true)
      }
      if (call > 5) {
        yield { type: 'text', text: 'done' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const events = await collect(runId, workspace)
    expect(events.some((e) => e.type === 'follow_up_dropped')).toBe(false)
    expectNoLoopSafetyStop(events)
  })

  it('continues past 4 mixed steps (probe fails + todo_write succeeds each step)', async () => {
    // Run 1de9344a pathology: every step mixed a failing environment probe with
    // successful todo/memory calls, yet each step was charged as all-failed and
    // the run died on LOOP_SAFETY at step 63. Mixed steps make progress — the
    // run must keep going.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > 5) {
        yield { type: 'text', text: 'environment mapped, proceeding' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `t${call}`, name: 'terminal', arguments: `{"command":"probe ${call}"}` }
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `w${call}`, name: 'todo_write', arguments: '{"todos":[{"id":"1","content":"x","status":"in_progress"}]}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockImplementation(async (name: string) => {
      if (name === 'terminal') {
        return { ok: false, summary: 'probe failed', content: 'stderr:\nnot recognized\nexit_code: 1' }
      }
      return { ok: true, summary: 'todos', content: '1 task' }
    })

    const runId = 'safety-mixed-steps'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(6)
    expectNoLoopSafetyStop(events)
    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).not.toContain('"code":"LOOP_SAFETY"')
  })

  it('keeps retrying even when the same failing attempt repeats (no failure cap)', async () => {
    // The former tool-failure streak stopped the run after 4 identical failed
    // attempts. Caps are removed: the model keeps trying until it succeeds.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > 6) {
        yield { type: 'text', text: 'succeeded on a later attempt' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: { id: `f${call}`, name: 'terminal', arguments: '{"command":"cargo test --release"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockResolvedValue({
      ok: false,
      summary: 'build failed',
      content: 'stderr:\nerror: could not compile\nexit_code: 101'
    })

    const runId = 'safety-all-fail-continues'
    const events = await collect(runId, workspace)

    expect(executeTool).toHaveBeenCalledTimes(6)
    expectNoLoopSafetyStop(events)
  })

  it('keeps exploring when failed attempts stay distinct (run 3d8e0ead replay)', async () => {
    // 2026-09-02: "gh pr checks" (exit 8) → "gh run view --log-failed" →
    // "--job --log" → "gh api .../logs" were four DISTINCT attempts against
    // one external blocker (GitHub serves no logs for in-progress runs).
    // Distinct attempts must never stop the run mid-investigation.
    const attempts = [
      'gh pr checks 17',
      'gh run view 33580725961 --log-failed 2>&1 | Select-Object -Last 120',
      'gh run view 33580725961 --job 100094249291 --log 2>&1 | Select-Object -Last 60',
      'gh api repos/vyotiqai/vyotiq-agent-v/actions/jobs/100094249291/logs > ci-macos.log 2>&1'
    ]
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > attempts.length) {
        yield {
          type: 'text',
          text: 'CI logs are gated until the run completes; waiting instead of retrying.'
        }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: {
          id: `gh${call}`,
          name: 'terminal',
          arguments: JSON.stringify({ command: attempts[call - 1], block_until_ms: 60000 })
        }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    // The real terminal tool echoes the command into its result; the failure
    // signature hashes that echo, so distinct commands stay distinct.
    executeTool.mockImplementation(async (_name: string, argsJson: string) => {
      const parsed = JSON.parse(argsJson) as { command?: string }
      return {
        ok: false,
        summary: 'gh',
        content: `status: done\ncommand: ${parsed.command ?? ''}\ncwd: /ws\nshell: powershell\nexit_code: 1\nstderr:\ngh : run 33580725961 is still in progress; logs will be available when it is complete`
      }
    })

    const runId = 'safety-novel-failures-continue'
    const events = await collect(runId, workspace)

    expectNoLoopSafetyStop(events)
    expect(streamChat).toHaveBeenCalledTimes(attempts.length + 1)
  })

  it('aborts a degenerate repeating generation and steer-continues with a synthetic turn', async () => {
    // Run be413e92 pathology: the generation streams identical ~1K blocks
    // forever. The monitor soft-aborts mid-stream; the step must flush the
    // partial output, emit a durable 'repetition' incomplete event, inject the
    // synthetic continue turn — then recover.
    const runId = 'safety-repetition-steer'
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        for (let i = 0; i < 12; i++) {
          yield { type: 'thinking_delta', text: 'X'.repeat(1024) }
        }
        return
      }
      yield { type: 'text', text: 'recovered with a fresh action' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'incomplete' && e.reason === 'repetition')).toBe(true)
    // The partial (aborted) generation is flushed as an assistant message.
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true)
    // The synthetic continue turn is injected before the next generation.
    const secondCallMessages = assembleContext.mock.calls[1][0].messages as Array<{
      role: string
      synthetic?: boolean
      content: string
    }>
    expect(
      secondCallMessages.some(
        (m) =>
          m.role === 'user' &&
          m.synthetic === true &&
          m.content.startsWith('Your output was cut off because it repeated the same text')
      )
    ).toBe(true)
    expectNoLoopSafetyStop(events)
  })

  it('keeps steer-continuing repeated degenerate generations instead of ending the turn', async () => {
    // The former MAX_REPETITION_ABORTS cap ended the turn after 3 repetition
    // aborts. Caps are removed: every degenerate generation steer-continues,
    // and the run finishes once a generation finally completes.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call <= 4) {
        for (let i = 0; i < 12; i++) {
          yield { type: 'thinking_delta', text: 'X'.repeat(1024) }
        }
        return
      }
      yield { type: 'text', text: 'finally recovered' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-repetition-no-cap'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(5)
    const repetitionEvents = events.filter(
      (e) => e.type === 'incomplete' && e.reason === 'repetition'
    )
    expect(repetitionEvents).toHaveLength(4)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
  })
})
