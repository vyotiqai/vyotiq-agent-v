import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-trim-${process.pid}-${Date.now()}`)

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
import { CLEARED_TOOL_RESULT_STUB } from '@main/agent/context/durableToolResults'

type Msg = { role: string; content: unknown }
type Req = { messages: Msg[] }

/** Tool-result bodies in the LAST request that actually reached the provider. */
function lastToolBodies(): string[] {
  const calls = streamChat.mock.calls
  const req = calls[calls.length - 1]?.[0] as Req | undefined
  return (req?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}

/** `readSteps` single-read steps, then a plain-text answer. */
function readThenFinish(readSteps: number) {
  let step = 0
  return async function* (): AsyncGenerator<StreamChunk> {
    step += 1
    if (step <= readSteps) {
      yield {
        type: 'tool_call',
        toolCall: { id: `c${step}`, name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) }
      } as StreamChunk
      yield { type: 'done', stopReason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'done' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

describe('tool-result trimming is gated on context pressure', () => {
  let workspace: string
  let estimatedTokens = 100

  beforeEach(() => {
    clearRunModelSelectionForTests()
    workspace = join(tmpdir(), `vyotiq-trim-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'contents\n', 'utf8')
    resetActiveRunsForTests()
    resetWorkspacesForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    executeTool.mockResolvedValue({
      ok: true,
      summary: 'a.txt',
      content: 'a file body long enough to be worth keeping'
    })
    estimatedTokens = 100
    assembleContextMock.mockReset()
    assembleContextMock.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens,
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

  async function run(runId: string, steps: number): Promise<void> {
    streamChat.mockImplementation(readThenFinish(steps))
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'explore' }],
      workspacePath: workspace
    })) {
      void _ev
    }
  }

  it('keeps every tool body while the window is nearly empty', async () => {
    // Well past keepLast + slack: the old unconditional trim cleared these.
    await run('trim-idle', 20)
    const bodies = lastToolBodies()
    expect(bodies.length).toBeGreaterThan(12)
    expect(bodies.filter((b) => b.includes(CLEARED_TOOL_RESULT_STUB))).toEqual([])
  }, 60_000)

  it('still trims once the context crosses the compaction threshold', async () => {
    estimatedTokens = 100_000_000
    await run('trim-pressure', 20)
    const bodies = lastToolBodies()
    expect(bodies.length).toBeGreaterThan(12)
    // Memory protection is intact: old bodies collapse, recent ones survive.
    expect(bodies.filter((b) => b.includes(CLEARED_TOOL_RESULT_STUB)).length).toBeGreaterThan(0)
    expect(bodies.filter((b) => !b.includes(CLEARED_TOOL_RESULT_STUB)).length).toBeGreaterThan(0)
  }, 60_000)

  /** Every tool-result body in the run's durable messages.jsonl. */
  function durableToolBodies(runId: string): string[] {
    const root = join(userData, 'workspaces')
    if (!existsSync(root)) return []
    for (const ws of readdirSync(root)) {
      const file = join(root, ws, 'sessions', runId, 'messages.jsonl')
      if (!existsSync(file)) continue
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { role?: string; content?: unknown }
          } catch {
            return {}
          }
        })
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    }
    return []
  }

  it('never writes trimmed bodies into durable history on an empty-turn retry', async () => {
    // Pressure on, so the working set really is trimmed; the empty turn then
    // rewrites messages.jsonl. That rewrite must come from disk, not RAM.
    estimatedTokens = 100_000_000
    let step = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      step += 1
      if (step <= 16) {
        yield {
          type: 'tool_call',
          toolCall: { id: `c${step}`, name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) }
        } as StreamChunk
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (step === 17) {
        // Empty turn: no text, no tool calls — triggers the durable rewrite.
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })

    for await (const _ev of runAgent({
      runId: 'trim-durable',
      messages: [{ role: 'user', content: 'explore' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    const durable = durableToolBodies('trim-durable')
    expect(durable.length).toBeGreaterThan(12)
    expect(durable.filter((b) => b.includes(CLEARED_TOOL_RESULT_STUB))).toEqual([])
  }, 60_000)

  /** Message history as sent on each request, serialised for exact comparison. */
  function historiesSent(): string[][] {
    return streamChat.mock.calls.map((c) =>
      ((c[0] as Req).messages ?? []).map((m) => JSON.stringify(m))
    )
  }

  it('never rewrites history in place, so the cached prefix can keep growing', async () => {
    await run('trim-prefix', 20)
    const histories = historiesSent()
    expect(histories.length).toBeGreaterThan(12)

    // Every request must extend the previous one, never edit it: a single
    // changed message invalidates the provider's cached prefix from there on,
    // which is what pinned cachedInputTokens flat while input kept growing.
    for (let i = 1; i < histories.length; i++) {
      const prev = histories[i - 1]!
      const next = histories[i]!
      expect(next.length).toBeGreaterThanOrEqual(prev.length)
      expect(next.slice(0, prev.length)).toEqual(prev)
    }
  }, 60_000)
})
