import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-model-fallback-${process.pid}-${Date.now()}`)

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
  return { ...actual, syncMcpServers: vi.fn(async () => {}), listMcpToolDefinitions: () => [] }
})

const { fallbackSetting } = vi.hoisted(() => ({
  fallbackSetting: { value: { enabled: true, models: [{ provider: 'openai', model: 'gpt-5.6-luna' }] } }
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
    modelFallback: fallbackSetting.value
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: (id: string) => (id === 'openai' ? 'sk-test-openai' : null),
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))
vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { primaryStream, fallbackStream, executeTool } = vi.hoisted(() => ({
  primaryStream: vi.fn(),
  fallbackStream: vi.fn(),
  executeTool: vi.fn()
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
      overflow: false,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/providers', () => ({
  getProvider: (id: string) => ({
    id: id === 'openai' ? 'openai' : 'ollama',
    listModels: async () => [],
    streamChat: id === 'openai' ? fallbackStream : primaryStream
  }),
  listProviderModels: async ({ provider }: { provider: string }) => ({
    models: [
      {
        id: provider === 'openai' ? 'gpt-5.6-luna' : 'qwen2.5',
        contextWindow: 128_000,
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
import { readUsageLedger } from '@main/agent/usageLedger'

type Ev = {
  type: string
  status?: string
  code?: string
  message?: string
  provider?: string
  model?: string
  fromProvider?: string
  fromModel?: string
  reason?: string
  estimatedCost?: number
}

async function collect(runId: string, workspace: string): Promise<Ev[]> {
  const events: Ev[] = []
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'do the thing' }],
    workspacePath: workspace
  })) {
    events.push(ev as Ev)
  }
  return events
}

const unavailable: StreamChunk = {
  type: 'error',
  error: 'Service Unavailable',
  errorCode: 'PROVIDER_HTTP',
  httpStatus: 503
}

describe('runAgent model fallback', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-model-fallback-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    primaryStream.mockReset()
    fallbackStream.mockReset()
    executeTool.mockReset()
    fallbackSetting.value = { enabled: true, models: [{ provider: 'openai', model: 'gpt-5.6-luna' }] }
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('moves the step to the fallback after the primary keeps failing with 503, and bills the fallback', async () => {
    const runId = 'fallback-503'
    primaryStream.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield unavailable
    })
    const seen: Array<{ model: string; apiKey: unknown; reasoningState: unknown }> = []
    fallbackStream.mockImplementation(async function* (req: {
      model: string
      apiKey: unknown
      reasoningState: unknown
    }): AsyncGenerator<StreamChunk> {
      seen.push({ model: req.model, apiKey: req.apiKey, reasoningState: req.reasoningState })
      yield { type: 'text', text: 'done on the fallback' }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 2000, outputTokens: 1000 } }
    })

    const events = await collect(runId, workspace)

    expect(primaryStream).toHaveBeenCalledTimes(2)
    expect(fallbackStream).toHaveBeenCalledTimes(1)
    expect(seen[0]).toEqual({ model: 'gpt-5.6-luna', apiKey: 'sk-test-openai', reasoningState: undefined })

    const switches = events.filter((e) => e.type === 'model_fallback')
    expect(switches).toHaveLength(1)
    expect(switches[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      fromProvider: 'ollama',
      fromModel: 'qwen2.5',
      reason: 'HTTP 503',
      message: 'Switched to gpt-5.6-luna — Ollama unavailable (HTTP 503)'
    })

    const usage = events.filter((e) => e.type === 'step_usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna' })
    // Priced by the fallback's published price (the primary is unpriced): 2000 × $0.5/M + 1000 × $4/M.
    expect(usage[0]!.estimatedCost).toBeCloseTo(0.005, 6)
    const ledger = readUsageLedger(resolveRunDir(workspace, runId))
    const day = Object.values(ledger?.days ?? {})[0] as { estimatedCost?: number } | undefined
    expect(day?.estimatedCost).toBeCloseTo(0.005, 6)

    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('keeps waiting on the primary for a usage-limit 429 — no fallback', async () => {
    let calls = 0
    primaryStream.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      calls += 1
      if (calls <= 3) {
        yield {
          type: 'error',
          error: 'Weekly usage limit reached. Resets in 6 days.',
          errorCode: 'PROVIDER_HTTP',
          httpStatus: 429
        }
        return
      }
      yield { type: 'text', text: 'recovered' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('fallback-quota', workspace)

    expect(calls).toBe(4)
    expect(fallbackStream).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'model_fallback')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('surfaces a 401 instead of falling back', async () => {
    primaryStream.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'error', error: 'Invalid API key', errorCode: 'PROVIDER_HTTP', httpStatus: 401 }
    })

    const events = await collect('fallback-401', workspace)

    expect(fallbackStream).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'model_fallback')).toBe(false)
    expect(events.some((e) => e.type === 'error' && e.code === 'PROVIDER_AUTH')).toBe(true)
  })

  it('changes nothing while the setting is off', async () => {
    fallbackSetting.value = { enabled: false, models: [{ provider: 'openai', model: 'gpt-5.6-luna' }] }
    let calls = 0
    primaryStream.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      calls += 1
      if (calls <= 3) {
        yield unavailable
        return
      }
      yield { type: 'text', text: 'back' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('fallback-off', workspace)

    expect(calls).toBe(4)
    expect(fallbackStream).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === 'model_fallback')).toBe(false)
  })
})
