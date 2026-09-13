import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { formatGoalInvocation, GOAL_CONTINUE_PREFIX } from '@shared/goalRuntime'

const userData = join(tmpdir(), `vyotiq-goal-loop-${process.pid}-${Date.now()}`)

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

vi.mock('@main/agent/harness', () => ({
  loadHarness: () => 'harness'
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      anthropicNative: undefined,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

const { streamChat } = vi.hoisted(() => ({
  streamChat: vi.fn()
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat
  }),
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
  executeTool: vi.fn()
}))

import { runAgent } from '@main/agent/loop'
import { cancelRun, resetActiveRunsForTests } from '@main/agent/runRegistry'
import { loadMessages } from '@main/agent/state'
import { readGoal } from '@main/agent/runGoal'
import { resolveRunDir } from '@main/storage/paths'

describe('runAgent goal auto-continue', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-goal-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('continues once then waits after two no-tool finishes', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'still working' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'goal-auto-continue'
    const events: Array<{ type: string; status?: string; reason?: string; message?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: formatGoalInvocation('make CI green') }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(streamChat.mock.calls.length).toBe(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    const runDir = resolveRunDir(workspace, runId)
    const goal = readGoal(runDir)
    expect(goal?.status).toBe('active')
    expect(goal?.continueCount).toBe(1)
    const messages = loadMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && String(m.content).startsWith(GOAL_CONTINUE_PREFIX))).toBe(
      true
    )
    // The injected continue turn is protocol, not a user prompt — it must be
    // flagged synthetic so the transcript never renders it as a user bubble.
    const continueMsg = messages.find(
      (m) => m.role === 'user' && String(m.content).startsWith(GOAL_CONTINUE_PREFIX)
    )
    expect(continueMsg?.synthetic).toBe(true)
    const persisted = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    expect(persisted).toContain('Two finishes without tools')
    // The stop must be durable + visible: a goal_wait incomplete event powers
    // the chat banner + Continue affordance (was toast-only).
    expect(persisted).toContain('"reason":"goal_wait"')
    const goalWait = events.find((e) => e.type === 'incomplete' && e.reason === 'goal_wait')
    expect(goalWait).toBeTruthy()
    expect(String(goalWait?.message)).toContain('Goal is still active')
  })

  it('auto-continues an active goal in Plan mode too, then waits visibly', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'plan only' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'goal-plan'
    const events: Array<{ type: string; reason?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: formatGoalInvocation('make CI green') }],
      workspacePath: workspace,
      mode: 'plan'
    })) {
      events.push(ev as { type: string; reason?: string })
    }
    // 2 plan nudges (no create_plan call) + 1 goal continue + final stop_wait.
    expect(streamChat.mock.calls.length).toBe(4)
    expect(loadMessages(workspace, runId).some((m) => String(m.content).startsWith(GOAL_CONTINUE_PREFIX))).toBe(
      true
    )
    expect(readGoal(resolveRunDir(workspace, runId))?.status).toBe('active')
    const goalWait = events.find((e) => e.type === 'incomplete' && e.reason === 'goal_wait')
    expect(goalWait).toBeTruthy()
    expect(
      readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    ).toContain('"reason":"goal_wait"')
  })

  it('leaves the goal active when the run is aborted (quit must still resume)', async () => {
    streamChat.mockImplementation(async function* (req: { signal: AbortSignal }): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' }
      while (!req.signal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const runId = 'goal-cancel'
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: formatGoalInvocation('make CI green') }],
      workspacePath: workspace
    })) {
      if (ev.type === 'text_delta') cancelRun(runId)
    }
    expect(readGoal(resolveRunDir(workspace, runId))?.status).toBe('active')
  })
})

describe('runAgent trivial-seed goal refresh', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-goal-refresh-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  function fakeStream(): AsyncGenerator<StreamChunk> {
    return (async function* () {
      yield { type: 'text', text: 'ok' }
      yield { type: 'done', stopReason: 'stop' }
    })()
  }

  function readContract(runId: string): string {
    return readFileSync(join(resolveRunDir(workspace, runId), 'contract.md'), 'utf8')
  }

  function readStatusGoal(runId: string): string | undefined {
    const raw = JSON.parse(
      readFileSync(join(resolveRunDir(workspace, runId), 'status.json'), 'utf8')
    ) as { goal?: string }
    return raw.goal
  }

  it('refreshes a trivial seeded goal from a meaningful follow-up message', async () => {
    streamChat.mockImplementation(() => fakeStream())

    const runId = 'goal-refresh-hi'
    // Invoke 1: trivial "hi" seeds the goal.
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }
    expect(readStatusGoal(runId)).toBe('hi')

    // Invoke 2 (resume of the same run): real task arrives.
    const realTask =
      'Audit and check the indexing and embedding pipeline end to end, find all the issues.'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: realTask }],
      workspacePath: workspace
    })) {
      // drain
    }
    const goal = readStatusGoal(runId)
    expect(goal).toBeTruthy()
    expect(goal!.length).toBeGreaterThan(12)
    expect(goal).toContain('indexing')
    expect(readContract(runId)).toContain('indexing')
  })

  it('keeps a deliberate longer goal untouched on follow-up invokes', async () => {
    streamChat.mockImplementation(() => fakeStream())

    const runId = 'goal-refresh-keep'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'Refactor the storage layer for durability' }],
      workspacePath: workspace
    })) {
      // drain
    }
    expect(readStatusGoal(runId)).toBe('Refactor the storage layer for durability')

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'now also add tests for it' }],
      workspacePath: workspace
    })) {
      // drain
    }
    expect(readStatusGoal(runId)).toBe('Refactor the storage layer for durability')
  })

  it('does not downgrade the goal when the follow-up is itself trivial', async () => {
    streamChat.mockImplementation(() => fakeStream())

    const runId = 'goal-refresh-trivial-followup'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'Plan the migration carefully and completely' }],
      workspacePath: workspace
    })) {
      // drain
    }
    const before = readStatusGoal(runId)

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'ok' }],
      workspacePath: workspace
    })) {
      // drain
    }
    expect(readStatusGoal(runId)).toBe(before)
  })
})
