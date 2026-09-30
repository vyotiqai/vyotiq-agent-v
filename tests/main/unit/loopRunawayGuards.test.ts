import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import type { RunReceipt } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-runaway-${process.pid}-${Date.now()}`)

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
import { loadLoopCheckpoint } from '@main/agent/loopCheckpoint'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'

type CapturedEvent = {
  type: string
  status?: string
  reason?: string
  message?: string
  content?: unknown
  kind?: string
}

function readReceipt(workspace: string, runId: string): RunReceipt {
  return JSON.parse(
    readFileSync(join(resolveRunDir(workspace, runId), 'receipt.json'), 'utf8')
  ) as RunReceipt
}

describe('runAgent runaway guards', () => {
  let workspace: string
  let events: CapturedEvent[]

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-runaway-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockClear()
    events = []
    executeTool.mockResolvedValue({ ok: true, summary: 'read', content: 'body' })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('stops a runaway step loop with a notice and a done status, never an error', async () => {
    // Every step does real work (a read) and answers nothing: no existing guard
    // owns that shape, so only the step ceiling can end it.
    let turn = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      turn += 1
      yield {
        type: 'tool_call',
        toolCall: { id: `c${turn}`, name: 'read', arguments: '{"path":"a.ts"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })

    const runId = 'runaway-ceiling'
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'do the work' }],
      workspacePath: workspace
    })) {
      events.push(ev as CapturedEvent)
    }

    const notice = events.find((e) => e.type === 'token_cost_hint')
    expect(notice?.message).toMatch(/stopped after \d+ steps/i)
    // Ended the way a finished run ends — no error, no throw out of the loop.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    // Exactly the ceiling's worth of steps, and no closing turn: the guard
    // fires at the top of the next iteration, before any model call.
    expect(turn).toBe(500)
    expect(loadLoopCheckpoint(resolveRunDir(workspace, runId))).toBeNull()
  }, 180_000)

  it('trips the tool-burst guard when a generation re-emits ONE call id', async () => {
    let turn = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      turn += 1
      if (turn > 1) {
        yield { type: 'text', text: 'picked up from the task list' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      // One id, re-emitted far past the cutoff. Distinct ids stay at one, so
      // a guard keyed on the id map never sees it.
      for (let i = 0; i < 100; i += 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: `{"path":"a${i}.ts"}` }
        }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })

    const runId = 'burst-one-id'
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'read them all' }],
      workspacePath: workspace
    })) {
      events.push(ev as CapturedEvent)
    }

    const burst = events.find((e) => e.type === 'incomplete' && e.reason === 'tool_burst')
    expect(burst?.message).toMatch(/more than \d+ tool calls/i)
    // Steer-continued, not killed: the run still finished normally.
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(turn).toBe(2)
  }, 60_000)

  it('clears the loop checkpoint when a hard provider error ends the run', async () => {
    let turn = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      turn += 1
      if (turn === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      // Permanent, non-retryable: no resume, so the run is over.
      yield {
        type: 'error',
        error: 'HTTP 401: invalid api key',
        errorCode: 'PROVIDER_HTTP',
        httpStatus: 401
      }
    })

    const runId = 'terminal-error-clears-checkpoint'
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'do the work' }],
      workspacePath: workspace
    })) {
      events.push(ev as CapturedEvent)
    }

    const runDir = resolveRunDir(workspace, runId)
    // The completed step wrote one, so the assertion is about the error path.
    expect(turn).toBe(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
    expect(loadLoopCheckpoint(runDir)).toBeNull()
  }, 60_000)

  it('does not record a clean gate verdict for a run that errored after mutating', async () => {
    let turn = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      turn += 1
      if (turn === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'edit', arguments: '{"path":"a.ts","diff":"x"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield {
        type: 'error',
        error: 'HTTP 401: invalid api key',
        errorCode: 'PROVIDER_HTTP',
        httpStatus: 401
      }
    })

    const runId = 'errored-receipt-verdict'
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'change a file' }],
      workspacePath: workspace
    })) {
      events.push(ev as CapturedEvent)
    }

    // Files changed, nothing ever checked the run, and the turn-end gate never
    // ran — so the receipt must say so, not persist the `wouldFire: false`
    // placeholder as a pass it never earned.
    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  }, 60_000)
})
