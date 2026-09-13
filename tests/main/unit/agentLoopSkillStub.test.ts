import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-skillstub-${process.pid}-${Date.now()}`)

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
    ollamaBaseUrl: 'http://[IP_ADDRESS]:11434',
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
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

// Spy wrappers over the real state module: the skill-stub gate in loop.ts must
// read + rewrite the durable transcript once per newly-stubbed body, and never
// again on later steps.
vi.mock('@main/agent/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/state')>()
  return {
    ...actual,
    loadMessagesAsync: vi.fn(actual.loadMessagesAsync),
    syncMessagesAsync: vi.fn(actual.syncMessagesAsync)
  }
})

import { runAgent } from '@main/agent/loop'
import { loadMessagesAsync, syncMessagesAsync } from '@main/agent/state'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { formatSkillInvocation, SKILL_BODY_STUB } from '@shared/slashCommands'

describe('runAgent skill-body stub rewrite gate', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-skillstub-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    vi.mocked(loadMessagesAsync).mockClear()
    vi.mocked(syncMessagesAsync).mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('rewrites the durable transcript once when the body first gets a follow-up, then skips later steps', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 't1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (call === 2) {
        yield {
          type: 'tool_call',
          toolCall: { id: 't2', name: 'read', arguments: '{"path":"b.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'docs run complete' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'a.ts', content: 'file body' })

    const skillUser = formatSkillInvocation('docs', 'LONG SKILL BODY', 'write docs')
    for await (const _ev of runAgent({
      runId: 'skill-stub-gate',
      messages: [{ role: 'user', content: skillUser }],
      workspacePath: workspace
    })) {
      // Drain the run.
    }

    // Step 1: skill turn is still the open (last) message — no stub, no disk
    // read. Step 2: follow-up exists — exactly one read + one rewrite. Step 3:
    // already stubbed — the idempotent pass reports 0 and the disk is untouched.
    expect(vi.mocked(loadMessagesAsync)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(syncMessagesAsync)).toHaveBeenCalledTimes(1)

    const transcript = readFileSync(
      join(resolveRunDir(workspace, 'skill-stub-gate'), 'messages.jsonl'),
      'utf8'
    )
    expect(transcript).toContain(SKILL_BODY_STUB)
    expect(transcript).not.toContain('LONG SKILL BODY')
  })
})
