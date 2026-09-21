import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-eff2-${process.pid}-${Date.now()}`)

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
    responseVerbosity: 'balanced',
    thinkingEnabled: true,
    thinkingEffort: 'max',
    showThinking: true,
    toolApproval: { mode: 'off', allowlist: [], mcpProtection: false }
  }),
  readLegacyWorkspacePath: () => null,
  clearSettingsCacheForTests: () => undefined
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => 'key',
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
        id: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

const executeTool = vi.fn()
vi.mock('@main/agent/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools')>()
  return { ...actual, executeTool: (...args: unknown[]) => executeTool(...args) }
})

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { clearRunModelSelectionForTests } from '@main/agent/runModelSelection'
import {
  saveWorkspacesState,
  defaultWorkspacesState,
  resetWorkspacesForTests
} from '@main/workspace/workspaces'

type Req = { thinking?: { enabled?: boolean; effort?: string } }

/** Efforts seen on the wire, one per model step, in order. */
function effortsSent(): Array<string | undefined> {
  return streamChat.mock.calls.map((c) => (c[0] as Req).thinking?.effort)
}

/** A step that calls `read`, then a final step with plain text. */
function readThenFinish(readSteps: number) {
  let step = 0
  return async function* (): AsyncGenerator<StreamChunk> {
    step += 1
    if (step <= readSteps) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: `c${step}`,
          name: 'read',
          arguments: JSON.stringify({ path: 'a.txt' })
        }
      } as StreamChunk
      yield { type: 'done', stopReason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'done exploring' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

/** A run of empty turns (no text, no tool calls), then a real answer. */
function emptyThenFinish(emptySteps: number) {
  let step = 0
  return async function* (): AsyncGenerator<StreamChunk> {
    step += 1
    if (step <= emptySteps) {
      yield { type: 'done', stopReason: 'stop' }
      return
    }
    yield { type: 'text', text: 'recovered' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

describe('adaptive thinking effort on the wire', () => {
  let workspace: string

  beforeEach(() => {
    clearRunModelSelectionForTests()
    workspace = join(tmpdir(), `vyotiq-eff2-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'contents\n', 'utf8')
    resetActiveRunsForTests()
    resetWorkspacesForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    executeTool.mockResolvedValue({ ok: true, summary: 'a.txt', content: 'contents' })
    assembleContextMock.mockReset()
    assembleContextMock.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      compaction: null
    }))
    saveWorkspacesState({
      ...defaultWorkspacesState(),
      openPaths: [workspace],
      activePath: workspace,
      recentPaths: []
    })
  })

  afterEach(() => {
    resetWorkspacesForTests()
    resetActiveRunsForTests()
    clearRunModelSelectionForTests()
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('holds the user ceiling through a short navigation chain', async () => {
    streamChat.mockImplementation(readThenFinish(1))
    for await (const _ev of runAgent({
      runId: 'effort-short-chain',
      messages: [{ role: 'user', content: 'look' }],
      workspacePath: workspace
    })) {
      void _ev
    }
    // One read step is not a chain: every request stays at the setting.
    expect(effortsSent().every((e) => e === 'max')).toBe(true)
  })

  it('steps down only after a sustained read-only chain, then recovers', async () => {
    streamChat.mockImplementation(readThenFinish(4))
    for await (const _ev of runAgent({
      runId: 'effort-long-chain',
      messages: [{ role: 'user', content: 'explore' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    // Exact wire values — a vacuous pass (thinking disabled, effort undefined)
    // would not match this.
    expect(effortsSent()).toEqual(['max', 'max', 'xhigh', 'high', 'high'])
  })

  it('retries an empty turn at a lower effort each time, then recovers', async () => {
    streamChat.mockImplementation(emptyThenFinish(2))
    for await (const _ev of runAgent({
      runId: 'effort-empty-retry',
      messages: [{ role: 'user', content: 'answer' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    // An empty turn is over-thinking that produced nothing, so the retry must
    // not re-run it at the same effort.
    expect(effortsSent()).toEqual(['max', 'xhigh', 'high'])
  })
})
