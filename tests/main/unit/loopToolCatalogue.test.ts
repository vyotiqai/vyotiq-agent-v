import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-toolcat-${process.pid}-${Date.now()}`)

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

vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

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

const executeTool = vi.fn()
vi.mock('@main/agent/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/tools')>()
  return { ...actual, executeTool: (...args: unknown[]) => executeTool(...args) }
})

import { runAgent } from '@main/agent/loop'
import { createRun } from '@main/agent/state'
import { instanceWorktreePath } from '@main/git/instanceWorktree'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { clearRunModelSelectionForTests } from '@main/agent/runModelSelection'
import {
  saveWorkspacesState,
  defaultWorkspacesState,
  resetWorkspacesForTests
} from '@main/workspace/workspaces'

type AssembleInput = { modeSection?: string }
type StreamInput = { tools?: { name: string }[] }

/**
 * The catalogue a run actually offers its model, as loop.ts built it — the
 * `tools` array handed to the provider, not a re-run of filterToolDefsForMode.
 */
function wireToolNames(): string[] {
  const calls = streamChat.mock.calls
  const req = calls[calls.length - 1]?.[0] as StreamInput | undefined
  return (req?.tools ?? []).map((t) => t.name)
}

/** The mode section assembled into this step's system prompt. */
function modeSection(): string {
  const calls = assembleContextMock.mock.calls
  return String((calls[calls.length - 1]?.[0] as AssembleInput | undefined)?.modeSection ?? '')
}

/** One tool-free turn, so the run ends after a single step. */
function scriptOneTurn(): void {
  streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text: 'done' }
    yield { type: 'done', stopReason: 'stop' }
  })
}

describe('loop.ts tool catalogue for an inline instance', () => {
  let workspace: string

  beforeEach(() => {
    clearRunModelSelectionForTests()
    resetActiveRunsForTests()
    resetWorkspacesForTests()
    workspace = join(tmpdir(), `vyotiq-toolcat-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.ts'), 'export const a = 1\n', 'utf8')
    streamChat.mockReset()
    executeTool.mockReset()
    scriptOneTurn()
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

  async function drain(runId: string): Promise<void> {
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'work in scope' }],
      workspacePath: workspace,
      mode: 'agent'
    })) {
      void _ev
    }
  }

  // A child capped to a path_scope with no worktree is refused terminal/git_commit
  // at dispatch (writeGuard.assertInlineInstanceUnscopedToolAllowed). Offering
  // them anyway spent 70 wasted turns in the app log; loop.ts must not.
  it('omits terminal and git_commit for a path_scope-shared instance, keeping diagnostics and run_tests', async () => {
    const runId = 'cat-scope-shared'
    createRun(workspace, runId, 'work in scope', {
      mode: 'agent',
      inlineInstance: true,
      pathScope: ['src/allowed']
    })

    await drain(runId)

    const names = wireToolNames()
    expect(names).not.toContain('terminal')
    expect(names).not.toContain('git_commit')
    // The tools that read the tree and write nothing stay — they are how such a
    // child checks its own work, and the guard never refused them.
    expect(names).toContain('diagnostics')
    expect(names).toContain('run_tests')
    expect(names).toContain('read')
    expect(names).toContain('edit')

    const section = modeSection()
    expect(section).toContain('path_scope')
    expect(section).toContain('diagnostics')
    expect(section).toContain('run_tests')
  }, 60_000)

  // The guard skips instances that own a worktree: they write in their own
  // tree, so the catalogue must be untouched.
  it('keeps terminal and git_commit for an inline instance that has a worktree', async () => {
    const runId = 'cat-worktree'
    const wt = instanceWorktreePath(workspace, runId)
    mkdirSync(wt, { recursive: true })
    createRun(workspace, runId, 'work in a worktree', {
      mode: 'agent',
      inlineInstance: true,
      pathScope: ['src/allowed'],
      worktreePath: wt
    })

    await drain(runId)

    const names = wireToolNames()
    expect(names).toContain('terminal')
    expect(names).toContain('git_commit')
    expect(modeSection()).not.toContain('shares the parent tree')
  }, 60_000)

  // A user-driven root run is never scope-shared, whatever it can reach.
  it('keeps terminal and git_commit for a root run', async () => {
    const runId = 'cat-root'
    createRun(workspace, runId, 'explore', { mode: 'agent' })

    await drain(runId)

    const names = wireToolNames()
    expect(names).toContain('terminal')
    expect(names).toContain('git_commit')
    expect(modeSection()).not.toContain('shares the parent tree')
  }, 60_000)
})