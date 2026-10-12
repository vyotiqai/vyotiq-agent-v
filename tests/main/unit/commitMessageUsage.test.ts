import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  recordAuxUsage: vi.fn(),
  resolveRunDir: vi.fn()
}))

vi.mock('@main/git/git', () => ({
  readCommitChanges: async () => ({
    files: [{ path: 'a.ts', kind: 'modified', added: 1, removed: 0, binary: false, untracked: false, diff: '+x' }],
    partial: false,
    key: `usage-test-${Math.random()}`
  }),
  readGitLog: async () => []
}))
vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5-coder',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
  })
}))
vi.mock('@main/settings/secrets', () => ({ getSecret: () => null }))
vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: () => null,
  readWorkspacesState: () => ({ settingsOverridesByPath: {} })
}))
vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'ollama', listModels: async () => [], streamChat: mocks.streamChat })
}))
vi.mock('@main/agent/usageLedger', () => ({ recordAuxUsage: mocks.recordAuxUsage }))
vi.mock('@main/agent/pricing', () => ({
  resolveRunModelPrice: async () => ({ price: { input: 1, output: 2 }, source: 'test', origin: 'custom' })
}))
vi.mock('@main/storage/paths', () => ({
  resolveRunDir: mocks.resolveRunDir,
  workspaceUsageDir: () => '/ws-usage',
  workspaceId: () => 'ws-id',
  workspaceMetaDir: () => tmpdir()
}))

import { generateCommitMessage } from '@main/git/commitMessage'

describe('commit message spend', () => {
  beforeEach(() => {
    mocks.recordAuxUsage.mockReset()
    mocks.resolveRunDir.mockReset()
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'fix: a thing' }
      yield { type: 'done', usage: { inputTokens: 1_000_000, outputTokens: 10 } }
    })
  })

  it('bills the task whose Changes asked, priced like a step', async () => {
    // The run's own directory: any folder that exists stands in for it.
    mocks.resolveRunDir.mockReturnValue(tmpdir())
    await generateCommitMessage('/ws', 'all', true, { runId: 'run-1' })
    expect(mocks.resolveRunDir).toHaveBeenCalledWith('/ws', 'run-1')
    expect(mocks.recordAuxUsage).toHaveBeenCalledWith(tmpdir(), {
      site: 'commit_message',
      inputTokens: 1_000_000,
      outputTokens: 10,
      estimatedCost: expect.closeTo(1.00002)
    })
  })

  it('bills the workspace when no task asked', async () => {
    await generateCommitMessage('/ws', 'all', true)
    expect(mocks.recordAuxUsage).toHaveBeenCalledWith('/ws-usage', expect.objectContaining({ site: 'commit_message' }))
  })

  it('bills the workspace when the task id names no run', async () => {
    mocks.resolveRunDir.mockImplementation(() => {
      throw new Error('Invalid run id')
    })
    await generateCommitMessage('/ws', 'all', true, { runId: '../x' })
    expect(mocks.recordAuxUsage).toHaveBeenCalledWith('/ws-usage', expect.objectContaining({ site: 'commit_message' }))
  })
})
