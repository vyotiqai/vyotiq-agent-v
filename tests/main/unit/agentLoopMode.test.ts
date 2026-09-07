import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import { createRun } from '@main/agent/state'
import { minimalReadyPlanMarkdown } from '@shared/planQuality'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-mode-${process.pid}-${Date.now()}`)

const getSettings = vi.fn(() => ({
  ...DEFAULT_SETTINGS,
  provider: 'ollama' as const,
  model: 'qwen2.5',
  ollamaBaseUrl: 'http://127.0.0.1:11434'
}))

const getSecret = vi.fn(() => null as string | null)
const secretStatus = vi.fn(() => ({
  encryptionAvailable: true,
  keys: {} as Record<string, never>
}))
const hasStoredSecretBlob = vi.fn(() => false)

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
  getSettings: () => getSettings(),
  readLegacyWorkspacePath: () => null,
  clearSettingsCacheForTests: () => undefined
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => getSecret(),
  secretStatus: () => secretStatus(),
  hasStoredSecretBlob: () => hasStoredSecretBlob()
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
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

const { streamChat, executeTool } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn()
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
      },
      {
        id: 'gpt-4o',
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
import { resetActiveRunsForTests, setPendingMode } from '@main/agent/runRegistry'

describe('runAgent mode and API key', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-mode-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    getSettings.mockReset()
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'ollama' as const,
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434'
    }))
    getSecret.mockReset()
    getSecret.mockReturnValue(null)
    secretStatus.mockReset()
    secretStatus.mockReturnValue({
      encryptionAvailable: true,
      keys: {} as Record<string, never>
    })
    hasStoredSecretBlob.mockReset()
    hasStoredSecretBlob.mockReturnValue(false)
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('Ask mode filters mutating tools from the provider tool list', async () => {
    let seenTools: string[] = []
    streamChat.mockImplementation(async function* (req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
      seenTools = (req.tools ?? []).map((t) => t.name)
      yield { type: 'text', text: 'read-only answer' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    for await (const _ of runAgent({
      runId: 'ask-filter',
      messages: [{ role: 'user', content: 'look around' }],
      workspacePath: workspace,
      mode: 'ask'
    })) {
      // drain
    }

    expect(seenTools).toContain('read')
    expect(seenTools).toContain('git_status')
    expect(seenTools).not.toContain('edit')
    expect(seenTools).not.toContain('terminal')
    expect(seenTools).not.toContain('delete')
    expect(existsSync(join(workspace, '.vyotiq'))).toBe(false)
  })

  it('Plan mode seeds plan.md under the run directory', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'drafting' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const runId = 'plan-seed'
    for await (const _ of runAgent({
      runId,
      messages: [{ role: 'user', content: 'plan a feature' }],
      workspacePath: workspace,
      mode: 'plan'
    })) {
      // drain
    }

    const planPath = join(resolveRunDir(workspace, runId), 'plan.md')
    expect(existsSync(planPath)).toBe(true)
    const planBody = readFileSync(planPath, 'utf8')
    expect(planBody).toContain('# Plan')
    expect(planBody).toContain('## Goal')
    expect(planBody).toContain('## Steps')
    expect(planBody).toContain('## Done when')
    expect(existsSync(join(workspace, '.vyotiq'))).toBe(false)
  })

  it('seeds plan.md when the run switches into Plan mode mid-run', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    const runId = 'plan-seed-mid-run'
    executeTool.mockImplementation(async () => {
      setPendingMode(runId, 'plan')
      return { ok: true, summary: 'file', content: 'ok' }
    })

    for await (const _ of runAgent({
      runId,
      messages: [{ role: 'user', content: 'work then plan' }],
      workspacePath: workspace,
      mode: 'agent'
    })) {
      // drain
    }

    const planPath = join(resolveRunDir(workspace, runId), 'plan.md')
    expect(existsSync(planPath)).toBe(true)
    expect(readFileSync(planPath, 'utf8')).toContain('# Plan')
    expect(readFileSync(planPath, 'utf8')).toContain('## Steps')
  })

  it('nudges a text-only Plan step when plan.md is not ready', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Here is the full plan in chat.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const runId = 'plan-chat-nudge'
    for await (const _ of runAgent({
      runId,
      messages: [{ role: 'user', content: 'plan the work' }],
      workspacePath: workspace,
      mode: 'plan'
    })) {
      // drain
    }

    expect(streamChat.mock.calls.length).toBe(3)
    const second = streamChat.mock.calls[1]![0] as ProviderChatRequest
    expect(JSON.stringify(second.messages)).toMatch(/create_plan/)
  })

  it('finishes a text-only Plan step when plan.md is already ready', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Plan is ready for review.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const runId = 'plan-ready-finish'
    const runDir = createRun(workspace, runId, 'plan the work', 'plan')
    writeFileSync(join(runDir, 'plan.md'), minimalReadyPlanMarkdown())

    for await (const _ of runAgent({
      runId,
      messages: [{ role: 'user', content: 'plan the work' }],
      workspacePath: workspace,
      mode: 'plan'
    })) {
      // drain
    }

    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it('defaults to Agent mode when mode is omitted', async () => {
    let seenTools: string[] = []
    streamChat.mockImplementation(async function* (req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
      seenTools = (req.tools ?? []).map((t) => t.name)
      yield { type: 'text', text: 'ok' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const events: Array<{ type: string; status?: string }> = []
    for await (const ev of runAgent({
      runId: 'agent-default',
      messages: [{ role: 'user', content: 'implement' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(seenTools).toContain('edit')
    expect(seenTools).toContain('terminal')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('exits early with PROVIDER_AUTH when a non-ollama API key is missing', async () => {
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'openai' as const,
      model: 'gpt-4o'
    }))
    getSecret.mockReturnValue(null)
    hasStoredSecretBlob.mockReturnValue(false)
    secretStatus.mockReturnValue({
      encryptionAvailable: true,
      keys: {} as Record<string, never>
    })

    const events: Array<{ type: string; status?: string; code?: string; message?: string }> = []
    for await (const ev of runAgent({
      runId: 'missing-key',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(streamChat).not.toHaveBeenCalled()
    const err = events.find((e) => e.type === 'error')
    expect(err?.code).toBe('PROVIDER_AUTH')
    expect(err?.message).toMatch(/API key for openai is not set/i)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
  })

  it('picks up autoModeSwitch toggle at the next step of a live run', async () => {
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'ollama' as const,
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      autoModeSwitch: false
    }))

    const seenToolsByCall: string[][] = []
    let call = 0
    streamChat.mockImplementation(async function* (
      req: ProviderChatRequest
    ): AsyncGenerator<StreamChunk> {
      call += 1
      seenToolsByCall.push((req.tools ?? []).map((t) => t.name))
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockImplementation(async () => {
      getSettings.mockImplementation(() => ({
        ...DEFAULT_SETTINGS,
        provider: 'ollama' as const,
        model: 'qwen2.5',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        autoModeSwitch: true
      }))
      return { ok: true, summary: 'file', content: 'ok' }
    })

    for await (const _ of runAgent({
      runId: 'auto-mode-mid-run',
      messages: [{ role: 'user', content: 'work' }],
      workspacePath: workspace,
      mode: 'agent'
    })) {
      // drain
    }

    expect(seenToolsByCall.length).toBe(2)
    expect(seenToolsByCall[0]).not.toContain('switch_mode')
    expect(seenToolsByCall[1]).toContain('switch_mode')
  })

  it('drops switch_mode on the next step when autoModeSwitch is turned off mid-run', async () => {
    getSettings.mockImplementation(() => ({
      ...DEFAULT_SETTINGS,
      provider: 'ollama' as const,
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      autoModeSwitch: true
    }))

    const seenToolsByCall: string[][] = []
    let call = 0
    streamChat.mockImplementation(async function* (
      req: ProviderChatRequest
    ): AsyncGenerator<StreamChunk> {
      call += 1
      seenToolsByCall.push((req.tools ?? []).map((t) => t.name))
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockImplementation(async () => {
      getSettings.mockImplementation(() => ({
        ...DEFAULT_SETTINGS,
        provider: 'ollama' as const,
        model: 'qwen2.5',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        autoModeSwitch: false
      }))
      return { ok: true, summary: 'file', content: 'ok' }
    })

    for await (const _ of runAgent({
      runId: 'auto-mode-mid-run-off',
      messages: [{ role: 'user', content: 'work' }],
      workspacePath: workspace,
      mode: 'agent'
    })) {
      // drain
    }

    expect(seenToolsByCall.length).toBe(2)
    expect(seenToolsByCall[0]).toContain('switch_mode')
    expect(seenToolsByCall[1]).not.toContain('switch_mode')
  })
})
