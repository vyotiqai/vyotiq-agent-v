import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `vyotiq-commit-draft-${process.pid}-${Date.now()}`)

const mocks = vi.hoisted(() => ({
  readGitDiff: vi.fn(),
  readGitLog: vi.fn(),
  readGitStatus: vi.fn(),
  streamChat: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : tmpdir()) }
}))
vi.mock('@main/git/git', () => ({
  readGitDiff: mocks.readGitDiff,
  readGitLog: mocks.readGitLog,
  readGitStatus: mocks.readGitStatus
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

import { generateCommitMessage } from '@main/git/commitMessage'

const workspace = join(userData, 'repo')
let replies: string[] = []

beforeEach(() => {
  mkdirSync(workspace, { recursive: true })
  replies = ['fix(updater): close the staging watcher before the swap', 'fix(updater): release the staging handle first']
  mocks.readGitDiff.mockResolvedValue({ ok: true, content: 'diff --git a/swap.ts b/swap.ts\n+await closeStagingWatcher()' })
  mocks.readGitStatus.mockResolvedValue({ kind: 'ok', status: { branch: 'main', files: [], truncated: false, fileCount: 1, added: 1, removed: 0, hasRemote: false, hasCommits: true } })
  mocks.readGitLog.mockResolvedValue([])
  mocks.streamChat.mockReset()
  mocks.streamChat.mockImplementation(async function* () {
    yield { type: 'text', text: replies.shift() ?? 'fix: nothing left' }
    yield { type: 'done' }
  })
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('drafted commit message', () => {
  it('writes one message per change set and hands it back without asking again', async () => {
    const first = await generateCommitMessage(workspace, 'all')
    expect(first).toEqual({ message: 'fix(updater): close the staging watcher before the swap', source: 'agent' })
    const again = await generateCommitMessage(workspace, 'all')
    expect(again).toEqual({ message: 'fix(updater): close the staging watcher before the swap', source: 'agent', reused: true })
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
  })

  it('asks again when the diff changes, when only the staged part is asked for, and on Rewrite', async () => {
    await generateCommitMessage(workspace, 'all')
    mocks.readGitDiff.mockResolvedValue({ ok: true, content: 'diff --git a/swap.ts b/swap.ts\n+await closeStagingWatcher()\n+log()' })
    await generateCommitMessage(workspace, 'all')
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
    await generateCommitMessage(workspace, 'staged')
    expect(mocks.streamChat).toHaveBeenCalledTimes(3)
    const rewritten = await generateCommitMessage(workspace, 'staged', true)
    expect(rewritten.reused).toBeUndefined()
    expect(mocks.streamChat).toHaveBeenCalledTimes(4)
  })

  it('keeps nothing when the model gives no usable message', async () => {
    replies = ['WIP', 'fix(updater): close the staging watcher before the swap']
    expect((await generateCommitMessage(workspace, 'all')).source).toBe('fallback')
    expect((await generateCommitMessage(workspace, 'all')).message).toBe('fix(updater): close the staging watcher before the swap')
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
  })
})
