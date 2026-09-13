import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@shared/logger'

const mocks = vi.hoisted(() => ({
  readGitDiff: vi.fn(),
  readGitLog: vi.fn(),
  readGitStatus: vi.fn(),
  streamChat: vi.fn(),
  getSettings: vi.fn(),
  getSecret: vi.fn()
}))

vi.mock('@main/git/git', () => ({
  readGitDiff: mocks.readGitDiff,
  readGitLog: mocks.readGitLog,
  readGitStatus: mocks.readGitStatus
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: mocks.getSettings
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: mocks.getSecret
}))

vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: () => null,
  readWorkspacesState: () => ({ settingsOverridesByPath: {} })
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat: mocks.streamChat
  })
}))

import { generateCommitMessage } from '@main/git/commitMessage'

describe('generateCommitMessage', () => {
  beforeEach(() => {
    mocks.readGitDiff.mockReset()
    mocks.readGitLog.mockReset()
    mocks.readGitStatus.mockReset()
    mocks.streamChat.mockReset()
    mocks.getSettings.mockReset()
    mocks.getSecret.mockReset()
    mocks.readGitDiff.mockResolvedValue({
      ok: true,
      content: 'diff --git a/src/tools/shell.ts b/src/tools/shell.ts\n+export function runShell() {}'
    })
    mocks.readGitStatus.mockResolvedValue({
      kind: 'ok',
      status: {
        branch: 'main',
        files: [
          {
            path: 'src/tools/shell.ts',
            status: 'added',
            added: 1,
            removed: 0,
            addedStaged: 0,
            removedStaged: 0,
            addedUnstaged: 1,
            removedUnstaged: 0,
            binary: false,
            staged: false,
            unstaged: true
          }
        ],
        truncated: false,
        fileCount: 1,
        added: 1,
        removed: 0,
        hasRemote: false,
        hasCommits: true
      }
    })
    mocks.readGitLog.mockResolvedValue([{ subject: 'feat(cli): add command runner' }])
    mocks.getSettings.mockReturnValue({
      provider: 'ollama',
      model: 'qwen2.5-coder',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
    })
    mocks.getSecret.mockReturnValue(null)
  })

  it('sends the selected diff and recent history to the configured agent model', async () => {
    mocks.streamChat.mockImplementation(async function* (request: { messages: Array<{ content: string }> }) {
      expect(request.messages[0]?.content).toContain('src/tools/shell.ts')
      expect(request.messages[0]?.content).toContain('feat(cli): add command runner')
      yield { type: 'text', text: 'feat(cli): add shell execution helper' }
      yield { type: 'done' }
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: 'feat(cli): add shell execution helper',
      source: 'agent'
    })
    expect(mocks.readGitDiff).toHaveBeenCalledTimes(1)
  })

  it('falls back without preventing commit when the provider returns an error', async () => {
    // The fallback choke point logs a warn with the reason for every branch —
    // asserted here once; every other fallback test below routes through it.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'error', error: 'provider unavailable' }
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'The model returned an error'
    })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Commit message generation unavailable'),
      expect.objectContaining({ code: 'COMMIT_MESSAGE_FALLBACK' })
    )
    warnSpy.mockRestore()
  })

  it('falls back with the diff reason when the diff cannot be read', async () => {
    mocks.readGitDiff.mockResolvedValue({ ok: false, error: 'git failed' })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'No diff content found for the selected changes'
    })
  })

  it('falls back with the settings reason when settings cannot be read', async () => {
    mocks.getSettings.mockImplementation(() => {
      throw new Error('settings unavailable')
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'Could not read chat settings'
    })
  })

  it('falls back with the api-key reason when the provider requires a key', async () => {
    mocks.getSettings.mockReturnValue({
      provider: 'custom',
      model: 'gpt',
      customOpenAiBaseUrl: 'https://api.example.com/v1'
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'No API key configured for custom'
    })
  })

  it('falls back with the timeout reason when generation aborts', async () => {
    vi.useFakeTimers()
    try {
      mocks.streamChat.mockImplementation(async function* (request: { signal: AbortSignal }) {
        yield { type: 'text', text: 'feat(cli): partial subject' }
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve()
          else request.signal.addEventListener('abort', () => resolve())
        })
        yield { type: 'text', text: ' never finished' }
      })

      const pending = generateCommitMessage('/ws', 'all')
      const expectation = expect(pending).resolves.toEqual({
        message: null,
        source: 'fallback',
        reason: 'Generation timed out'
      })
      await vi.advanceTimersByTimeAsync(12_000)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back with the connectivity reason when the provider stream throws', async () => {
    mocks.streamChat.mockImplementation(() => {
      throw new Error('ECONNREFUSED')
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'Could not reach the model'
    })
  })

  it('falls back with the parse reason when the reply is a rejected placeholder', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'Update 11 files' }
      yield { type: 'done' }
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'The model reply was not a usable commit message'
    })
  })

  it('falls back when the model returns no text at all', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'done' }
    })

    await expect(generateCommitMessage('/ws', 'all')).resolves.toEqual({
      message: null,
      source: 'fallback',
      reason: 'The model returned no text'
    })
  })
})
