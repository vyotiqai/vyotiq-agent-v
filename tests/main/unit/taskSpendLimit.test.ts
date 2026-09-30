import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import type { AgentQuestionRequest } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-spend-${process.pid}-${Date.now()}`)

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

const settings = vi.hoisted(() => ({ taskSpendLimitUsd: 1 }))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
    taskSpendLimitUsd: settings.taskSpendLimitUsd
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
    compaction: null
  }))
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (input: { messages: unknown[] }) => assembleContext(input),
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
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { registerQuestionSender, resetAgentQuestionForTests, resolveAgentQuestion } from '@main/agent/agentQuestion'
import {
  noteLiveInstanceSpend,
  publishTaskOwnSpend,
  readTaskSpend,
  registerInstanceTask,
  resetTaskSpendForTests
} from '@main/agent/taskSpend'
import { createRun } from '@main/agent/state'

type CapturedEvent = { type: string; status?: string; reason?: string; message?: string }

/** Every step reads a file and the provider bills $0.60 for it; step `finishAt` answers instead. */
function billedSteps(finishAt: number): () => number {
  let turn = 0
  streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
    turn += 1
    if (turn >= finishAt) {
      yield { type: 'text', text: 'All done.' }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 100, outputTokens: 10, billedCost: 0.6 } }
      return
    }
    yield { type: 'tool_call', toolCall: { id: `c${turn}`, name: 'read', arguments: '{"path":"a.ts"}' } }
    yield { type: 'done', stopReason: 'tool_calls', usage: { inputTokens: 100, outputTokens: 10, billedCost: 0.6 } }
  })
  return () => turn
}

describe('task spend limit', () => {
  let workspace: string
  let events: CapturedEvent[]
  let asked: AgentQuestionRequest[]

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-spend-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    resetAgentQuestionForTests()
    resetTaskSpendForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    executeTool.mockResolvedValue({ ok: true, summary: 'read', content: 'body' })
    settings.taskSpendLimitUsd = 1
    events = []
    asked = []
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  /** Answer the spend question the way the renderer does, through resolveAgentQuestion. */
  function answerWith(runId: string, choose: (options: string[]) => string): void {
    registerQuestionSender(runId, (request) => {
      asked.push(request)
      const item = request.questions[0]!
      queueMicrotask(() => {
        resolveAgentQuestion({
          requestId: request.requestId,
          runId,
          answers: [{ questionId: item.id, values: [choose(item.options ?? [])] }]
        })
      })
    })
  }

  async function run(runId: string): Promise<void> {
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'do the work' }],
      workspacePath: workspace
    })) {
      events.push(ev as CapturedEvent)
    }
  }

  it('asks before the next model call once the task is over its limit, and stops when told to', async () => {
    const turns = billedSteps(10)
    const runId = 'spend-stop'
    answerWith(runId, () => 'Stop here')
    await run(runId)

    // $0.60 + $0.60 crosses $1: the third call never happens.
    expect(turns()).toBe(2)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.title).toBe('Spend limit reached')
    expect(asked[0]!.questions[0]!.prompt).toBe(
      'This task has spent $1.20 of its $1.00 limit, helper instances included. Let it spend more?'
    )
    expect(asked[0]!.questions[0]!.options).toEqual(['Allow another $1.00', 'Stop here'])
    const stop = events.find((e) => e.type === 'incomplete')
    expect(stop?.reason).toBe('spend_limit')
    expect(stop?.message).toMatch(/^Stopped at the spend limit: this task has spent \$1\.20 of its \$1\.00\./)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
  }, 60_000)

  it('allows another stretch when asked, remembers it with the task, and asks again past it', async () => {
    const turns = billedSteps(10)
    const runId = 'spend-more'
    let answers = 0
    answerWith(runId, (options) => {
      answers += 1
      return answers === 1 ? options[0]! : 'Stop here'
    })
    await run(runId)

    // $1.20 → allow $1 more (limit $2) → $1.80 → $2.40 ≥ $2 → asks again → stop.
    expect(turns()).toBe(4)
    expect(asked).toHaveLength(2)
    expect(asked[1]!.questions[0]!.prompt).toMatch(/spent \$2\.40 of its \$2\.00 limit/)
    expect(readTaskSpend(resolveRunDir(workspace, runId)).allowanceUsd).toBe(1)
    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('spend_limit')
  }, 60_000)

  it('stops rather than spends when no window can ask', async () => {
    const turns = billedSteps(10)
    await run('spend-no-window')
    expect(turns()).toBe(2)
    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('spend_limit')
  }, 60_000)

  it('never asks with the limit off, and a task under it finishes normally', async () => {
    settings.taskSpendLimitUsd = 0
    const off = billedSteps(4)
    await run('spend-off')
    expect(off()).toBe(4)
    expect(events.some((e) => e.type === 'incomplete')).toBe(false)

    events = []
    settings.taskSpendLimitUsd = 5
    const under = billedSteps(3)
    answerWith('spend-under', () => 'Stop here')
    await run('spend-under')
    expect(under()).toBe(3)
    expect(asked).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
  }, 60_000)

  it('stops a helper instance once its task is over the limit, without asking', async () => {
    const turns = billedSteps(10)
    const taskId = 'spend-parent'
    const childId = 'spend-child'
    // The task itself has spent $0.90 so far; the helper bills $0.60 a step.
    publishTaskOwnSpend(taskId, 0.9)
    createRun(workspace, childId, 'help', { inlineInstance: true, parentRunId: taskId })
    registerInstanceTask(childId, { runId: taskId, runDir: resolveRunDir(workspace, taskId) })
    answerWith(childId, () => 'Allow another $1.00')

    let childSpend = 0
    for await (const ev of runAgent({ runId: childId, messages: [{ role: 'user', content: 'help' }], workspacePath: workspace })) {
      events.push(ev as CapturedEvent)
      // What startAgentRun's noteInstanceChildEvent does with each step's usage.
      if ((ev as { type: string }).type === 'step_usage') {
        childSpend += (ev as { billedCost?: number }).billedCost ?? 0
        noteLiveInstanceSpend(childId, childSpend)
      }
    }

    // $0.90 + $0.60 crosses $1 after one helper step; only the task asks.
    expect(turns()).toBe(1)
    expect(asked).toHaveLength(0)
    const stop = events.find((e) => e.type === 'incomplete')
    expect(stop?.reason).toBe('spend_limit')
    expect(stop?.message).toBe(
      'Stopped: the task has spent $1.50 of its $1.00 spend limit. The main task asks whether to spend more.'
    )
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
  }, 60_000)
})
