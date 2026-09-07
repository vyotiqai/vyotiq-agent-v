import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import {
  MAX_CONSECUTIVE_TOOL_FAILURE_STEPS,
  MAX_IDENTICAL_REASONING_STREAK_HINT,
  MAX_IDENTICAL_REASONING_STREAK_TERMINAL,
  MAX_IDENTICAL_STEP_STREAK,
  MAX_REPETITION_ABORTS
} from '@main/agent/loopPolicy'

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

describe('runAgent LOOP_SAFETY integration', () => {
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

  it('continues after the same tool call repeats beyond the former identical streak', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > MAX_IDENTICAL_STEP_STREAK + 2) {
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

    expect(streamChat).toHaveBeenCalledTimes(MAX_IDENTICAL_STEP_STREAK + 3)
    expect(executeTool).toHaveBeenCalledTimes(MAX_IDENTICAL_STEP_STREAK + 2)
    expectNoLoopSafetyStop(events)

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).not.toContain('"code":"LOOP_SAFETY"')
  })

  it('auto-continues truncated text then finishes without LOOP_SAFETY', async () => {
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
      if (call === MAX_IDENTICAL_STEP_STREAK) {
        const queued = enqueueFollowUp(runId, { role: 'user', content: 'late steer' })
        expect(queued.ok).toBe(true)
      }
      if (call > MAX_IDENTICAL_STEP_STREAK + 2) {
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
    // failure streak must reset.
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

  it('still stops when the same failing attempt repeats (guard intact)', async () => {
    // Novelty rule: identical arguments + identical error output is a spin,
    // not progress — the terminal streak must still stop the run.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call > MAX_CONSECUTIVE_TOOL_FAILURE_STEPS) {
        yield { type: 'text', text: 'giving up' }
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

    const runId = 'safety-all-fail-still-stops'
    const events = await collect(runId, workspace)

    const loopStop = events.find((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')
    expect(loopStop).toBeTruthy()
    expect(String(loopStop?.message)).toContain('failed 4 steps in a row')
    expect(String(loopStop?.message)).toContain('no new attempt shape')
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })

  it('keeps exploring when failed attempts stay distinct (run 3d8e0ead replay)', async () => {
    // 2026-09-02: "gh pr checks" (exit 8) → "gh run view --log-failed" →
    // "--job --log" → "gh api .../logs" were four DISTINCT attempts against
    // one external blocker (GitHub serves no logs for in-progress runs). The
    // old all-failed counter reached 4 and killed the run mid-investigation;
    // the novelty rule must hold the streak while attempts stay distinct.
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

  it(
    'runaway 500-step guard emits a visible LOOP_SAFETY error and a fresh continue resets the step budget',
    { timeout: 120_000 },
    async () => {
      // Run 6265fa90 (2026-09-01): the runaway guard fired with NO error event
      // (bare "Run failed" in the UI) and every app restart re-fired it ~200ms
      // in — status running → error, no steps, no provider call — because the
      // restored step counter sat at the ceiling and the guard checked before
      // any provider call. The guard's own message promises "Send continue to
      // keep going"; that must actually continue.
      let call = 0
      streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
        call += 1
        if (call <= 500) {
          yield {
            type: 'tool_call',
            toolCall: { id: `c${call}`, name: 'read', arguments: `{"path":"f${call}.ts"}` }
          }
          yield { type: 'done', stopReason: 'tool_calls' }
          return
        }
        yield { type: 'text', text: 'resumed and finished' }
        yield { type: 'done', stopReason: 'stop' }
      })
      executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

      const runId = 'safety-runaway-resume'
      const first = await collect(runId, workspace)

      const guard = first.find((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')
      expect(guard).toBeTruthy()
      expect(String(guard?.message)).toContain('500 agent steps')
      expect(first.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
      // The reason must be persisted so it survives an app restart.
      const runDir = resolveRunDir(workspace, runId)
      const persisted = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
      expect(persisted).toContain('"code":"LOOP_SAFETY"')
      expect(persisted).toContain('runaway-loop guard')
      const statusRaw = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')) as {
        step: number
      }
      expect(statusRaw.step).toBeGreaterThanOrEqual(500)

      const resumed = await collect(runId, workspace, { resume: true })
      // Without the step-budget reset the resumed run would hit the guard
      // before streaming anything: no new stream call and a LOOP_SAFETY error.
      expect(resumed.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
      expect(resumed.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
      expect(streamChat).toHaveBeenCalledTimes(501)
    }
  )

  it('aborts a degenerate repeating generation and steer-continues with a synthetic turn', async () => {
    // Run be413e92 pathology: the generation streams identical ~1K blocks
    // forever. The monitor soft-aborts mid-stream; the step must flush the
    // partial output, emit a durable 'repetition' incomplete event, inject the
    // synthetic continue turn, and persist the abort counter — then recover.
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
      // Step 2 runs after the repetition steer: the checkpoint must already
      // carry the persisted abort counter.
      const checkpoint = JSON.parse(
        readFileSync(join(resolveRunDir(workspace, runId), 'loopCheckpoint.json'), 'utf8')
      ) as { repetitionAborts?: number }
      expect(checkpoint.repetitionAborts).toBe(1)
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

  it('ends the turn after MAX_REPETITION_ABORTS degenerate generations', async () => {
    // Every generation loops; after the cap the turn ends (status done) and no
    // further generation burns tokens — the truncated auto-continue cap shape.
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      for (let i = 0; i < 12; i++) {
        yield { type: 'thinking_delta', text: 'X'.repeat(1024) }
      }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-repetition-cap'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(MAX_REPETITION_ABORTS + 1)
    const repetitionEvents = events.filter(
      (e) => e.type === 'incomplete' && e.reason === 'repetition'
    )
    expect(repetitionEvents).toHaveLength(MAX_REPETITION_ABORTS + 1)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
  })

  it('escalates the reasoning hint at streak 3 and stops terminally at streak 6 (no-tool step included)', async () => {
    let call = 0
    const reasoning =
      'I have gone in circles again; the task list already reflects current statuses.'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call <= MAX_IDENTICAL_REASONING_STREAK_TERMINAL - 1) {
        // Tool-call steps 1..5: identical reasoning, distinct tool args (so the
        // identical-STEP streak stays at 1 and only the reasoning streak climbs).
        yield { type: 'thinking_delta', text: reasoning }
        yield { type: 'text', text: 'Working on it.' }
        yield {
          type: 'tool_call',
          toolCall: { id: `c${call}`, name: 'read', arguments: `{"path":"a${call}.ts"}` }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      // Step 6: no tool call — the terminal reasoning stop must still fire.
      // Same thinking + assistant text as steps 1-5 so the reasoning
      // fingerprint matches and the streak reaches the terminal threshold.
      yield { type: 'thinking_delta', text: reasoning }
      yield { type: 'text', text: 'Working on it.' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-reasoning-streak'
    const events = await collect(runId, workspace)

    expect(streamChat).toHaveBeenCalledTimes(MAX_IDENTICAL_REASONING_STREAK_TERMINAL)
    // The hint escalates into the prompt from the step AFTER the streak hits 3.
    const hintAt = (stepIndex: number): string | undefined =>
      (assembleContext.mock.calls[stepIndex][0] as unknown as { loopHint?: string }).loopHint
    expect(hintAt(MAX_IDENTICAL_REASONING_STREAK_HINT - 1)).toBeUndefined()
    expect(hintAt(MAX_IDENTICAL_REASONING_STREAK_HINT)).toContain('repeating the same reasoning')
    // Terminal stop on the no-tool-call step.
    const loopStop = events.find((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')
    expect(loopStop).toBeTruthy()
    expect(String(loopStop?.message)).toContain('near-identical reasoning repeated 6 steps in a row')
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })

  it('resets the reasoning streak on different reasoning and on empty fingerprints', async () => {
    let call = 0
    const reasoning =
      'I have gone in circles again; the task list already reflects current statuses.'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call <= 3) {
        yield { type: 'thinking_delta', text: reasoning }
        yield { type: 'text', text: 'Working on it.' }
        yield {
          type: 'tool_call',
          toolCall: { id: `c${call}`, name: 'read', arguments: `{"path":"a${call}.ts"}` }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (call === 4) {
        // Different reasoning resets the streak to 1.
        yield { type: 'thinking_delta', text: 'completely different approach now' }
        yield { type: 'text', text: 'New plan.' }
        yield {
          type: 'tool_call',
          toolCall: { id: 'c4', name: 'read', arguments: '{"path":"b.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (call === 5) {
        // No thinking and no text: the empty fingerprint resets the streak to 0.
        yield {
          type: 'tool_call',
          toolCall: { id: 'c5', name: 'read', arguments: '{"path":"c.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'safety-reasoning-reset'
    const events = await collect(runId, workspace)

    const hintAt = (stepIndex: number): string | undefined =>
      (assembleContext.mock.calls[stepIndex][0] as unknown as { loopHint?: string }).loopHint
    expect(hintAt(2)).toBeUndefined()
    // Streak hit 3 after step 3 — step 4 carries the hint.
    expect(hintAt(3)).toContain('repeating the same reasoning')
    // Different reasoning reset the streak — step 5 carries no hint.
    expect(hintAt(4)).toBeUndefined()
    // '' fingerprint reset the streak — step 6 carries no hint.
    expect(hintAt(5)).toBeUndefined()
    expectNoLoopSafetyStop(events)
    expect(streamChat).toHaveBeenCalledTimes(6)
  })
})
