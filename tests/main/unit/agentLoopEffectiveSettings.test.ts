import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-eff-${process.pid}-${Date.now()}`)

const { assembleContextMock } = vi.hoisted(() => ({
  assembleContextMock: vi.fn()
}))

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
    telemetryEnabled: false,
    agentPersona: 'GlobalBot',
    agentTone: 'calm',
    responseVerbosity: 'balanced'
  }),
  readLegacyWorkspacePath: () => null,
  clearSettingsCacheForTests: () => undefined
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
    assembleContext: assembleContextMock,
    ensureMemoryLayout: () => undefined
  }
})

const streamChat = vi.fn()

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat
  }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'override-model',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: false,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: vi.fn()
}))

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { clearRunModelSelectionForTests } from '@main/agent/runModelSelection'
import { saveWorkspacesState, defaultWorkspacesState, resetWorkspacesForTests } from '@main/workspace/workspaces'

describe('runAgent effective workspace settings', () => {
  let workspace: string

  beforeEach(() => {
    clearRunModelSelectionForTests()
    workspace = join(tmpdir(), `vyotiq-eff-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    resetWorkspacesForTests()
    streamChat.mockReset()
    assembleContextMock.mockReset()
    assembleContextMock.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      anthropicNative: undefined,
      compaction: null
    }))
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspace],
      activePath: workspace,
      recentPaths: [],
      settingsOverridesByPath: {
        [workspace]: {
          useOverride: true,
          provider: 'ollama',
          model: 'override-model'
        }
      }
    })
  })

  afterEach(() => {
    resetWorkspacesForTests()
    resetActiveRunsForTests()
    clearRunModelSelectionForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('uses workspace override for model instead of global settings', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
      yield { type: 'done' }
    })

    const runId = 'effective-settings'
    const events: Array<{ type: string; status?: string; code?: string }> = []

    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(streamChat).toHaveBeenCalled()
    const request = streamChat.mock.calls[0]?.[0] as { model?: string }
    expect(request.model).toBe('override-model')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('uses the invoke session model over the workspace override', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
      yield { type: 'done' }
    })

    for await (const _ev of runAgent({
      runId: 'session-model-pin',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace,
      provider: 'ollama',
      model: 'session-model'
    })) {
      void _ev
    }

    expect(streamChat).toHaveBeenCalled()
    const request = streamChat.mock.calls[0]?.[0] as { model?: string }
    expect(request.model).toBe('session-model')
  })

  it('recalls the run model for main-originated follow-up invokes', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
      yield { type: 'done' }
    })

    const runId = 'follow-up-model-pin'
    // First invoke: the renderer passed this session's model selection.
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace,
      model: 'session-model'
    })) {
      void _ev
    }

    // Second invoke carries no renderer selection (follow-up promote / goal
    // relaunch): the workspace override says 'override-model', but the run
    // keeps its own model — another session's model change cannot bleed in.
    for await (const _ev of runAgent({
      runId,
      newMessages: [{ role: 'user', content: 'continue' }],
      workspacePath: workspace,
      resume: true
    })) {
      void _ev
    }

    expect(streamChat.mock.calls.length).toBeGreaterThanOrEqual(2)
    const secondCall = streamChat.mock.calls.at(-1)?.[0] as { model?: string }
    expect(secondCall.model).toBe('session-model')
  })

  it('uses global persona and tone when no workspace override is active', async () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspace],
      activePath: workspace,
      recentPaths: [],
      settingsOverridesByPath: {}
    })
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
      yield { type: 'done' }
    })

    for await (const _ev of runAgent({
      runId: 'global-persona',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    expect(assembleContextMock).toHaveBeenCalled()
    const input = assembleContextMock.mock.calls[0]?.[0] as {
      persona?: string
      tone?: string
      responseVerbosity?: string
    }
    expect(input.persona).toBe('GlobalBot')
    expect(input.tone).toBe('calm')
    expect(input.responseVerbosity).toBe('balanced')
  })

  it('uses workspace override persona and tone instead of global settings', async () => {
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspace],
      activePath: workspace,
      recentPaths: [],
      settingsOverridesByPath: {
        [workspace]: {
          useOverride: true,
          provider: 'ollama',
          model: 'override-model',
          agentPersona: 'OverrideBot',
          agentTone: 'terse',
          responseLanguage: 'German'
        }
      }
    })
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
      yield { type: 'done' }
    })

    for await (const _ev of runAgent({
      runId: 'override-persona',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    expect(assembleContextMock).toHaveBeenCalled()
    const input = assembleContextMock.mock.calls[0]?.[0] as {
      persona?: string
      tone?: string
      responseLanguage?: string
      responseVerbosity?: string
    }
    expect(input.persona).toBe('OverrideBot')
    expect(input.tone).toBe('terse')
    expect(input.responseLanguage).toBe('German')
    expect(input.responseVerbosity).toBe('balanced')
  })
})
