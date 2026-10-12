import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructureContext } from '@main/agent/promptStructure/context'

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  getSettings: vi.fn(),
  getSecret: vi.fn(),
  gather: vi.fn(),
  recordAuxUsage: vi.fn()
}))

vi.mock('@main/settings/settings', () => ({ getSettings: mocks.getSettings }))
vi.mock('@main/settings/secrets', () => ({ getSecret: mocks.getSecret }))
vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: () => null,
  readWorkspacesState: () => ({ settingsOverridesByPath: {} })
}))
vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'ollama', listModels: async () => [], streamChat: mocks.streamChat })
}))
vi.mock('@main/agent/usageLedger', () => ({ recordAuxUsage: mocks.recordAuxUsage }))
vi.mock('@main/agent/pricing', () => ({ resolveRunModelPrice: async () => null }))
vi.mock('@main/storage/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/storage/paths')>()),
  resolveRunDir: () => '/nonexistent-run-dir',
  workspaceUsageDir: () => '/ws-usage'
}))
vi.mock('@main/agent/promptStructure/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/agent/promptStructure/context')>()),
  gatherStructureContext: mocks.gather
}))

import {
  cancelPromptStructure,
  clearPromptStructureCacheForTests,
  structurePrompt
} from '@main/agent/promptStructure'
import { PromptStructureRequestSchema } from '@shared/ipc'

const context: StructureContext = {
  rules: '',
  memory: '',
  pastTasks: '',
  thread: '',
  repo: '2 files.',
  relevantPaths: 'src/composer/Composer.tsx',
  scripts: 'Package manager: pnpm. Scripts:\n- `pnpm test` → vitest run',
  known: {
    files: ['src/composer/Composer.tsx', 'package.json'],
    dirs: ['src', 'src/composer'],
    packageManager: 'pnpm',
    scripts: new Set(['test']),
    makeTargets: new Set(),
    justRecipes: new Set(),
    rulesText: ''
  }
}

function request(over: Record<string, unknown> = {}) {
  return PromptStructureRequestSchema.parse({
    requestId: `r-${Math.random()}`,
    workspacePath: '/ws',
    text: 'fix the composer paste crash [[@1]]',
    mentions: [{ token: '[[@1]]', kind: 'file', label: 'Composer.tsx', path: 'src/composer/Composer.tsx' }],
    mode: 'agent',
    ...over
  })
}

/** One model reply per call, in order. */
function replies(...texts: string[]): void {
  for (const text of texts) {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text }
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } }
    })
  }
}

const brief = (text: string, taskType = 'bug'): string => JSON.stringify({ kind: 'brief', taskType, brief: text })

describe('structurePrompt', () => {
  beforeEach(() => {
    clearPromptStructureCacheForTests()
    mocks.streamChat.mockReset()
    mocks.gather.mockReset().mockResolvedValue(context)
    mocks.recordAuxUsage.mockReset()
    mocks.getSettings.mockReset().mockReturnValue({
      provider: 'ollama',
      model: 'qwen2.5-coder',
      ollamaBaseUrl: 'http://127.0.0.1:11434'
    })
    mocks.getSecret.mockReset().mockReturnValue(null)
  })

  it('writes a brief with the chip kept, on the composer’s model, and records the spend', async () => {
    replies(brief('Fix the paste crash in [[@1]].\n\n## Verify\n- Run `pnpm test`.'))
    const result = await structurePrompt(request({ provider: 'ollama', model: 'llama3' }))
    expect(result).toEqual({
      kind: 'brief',
      taskType: 'bug',
      brief: 'Fix the paste crash in [[@1]].\n\n## Verify\n- Run `pnpm test`.'
    })
    const call = mocks.streamChat.mock.calls[0]![0] as { model: string; tools: unknown[]; system: string; messages: Array<{ content: string }> }
    expect(call.model).toBe('llama3')
    expect(call.tools).toEqual([])
    expect(call.system).toContain('You do not do the task')
    expect(call.messages[0]!.content).toContain('<instruction>\nfix the composer paste crash [[@1]]\n</instruction>')
    // No task yet: the workspace's own ledger carries it.
    expect(mocks.recordAuxUsage).toHaveBeenCalledWith('/ws-usage', expect.objectContaining({ site: 'prompt_structure', inputTokens: 100 }))
  })

  it('passes questions through when the request is ambiguous', async () => {
    replies(JSON.stringify({ kind: 'questions', taskType: 'bug', questions: [{ question: 'Which paste?', options: ['Text', 'Image'] }] }))
    await expect(structurePrompt(request())).resolves.toEqual({
      kind: 'questions',
      taskType: 'bug',
      questions: [{ id: 'q1', question: 'Which paste?', options: ['Text', 'Image'], multi: false }]
    })
  })

  it('asks once more when the reply is not the JSON, then uses the second reply', async () => {
    replies('Sure, here is a better prompt!', brief('Fix it. [[@1]]'))
    const result = await structurePrompt(request())
    expect(result).toMatchObject({ kind: 'brief', brief: 'Fix it. [[@1]]' })
    const second = mocks.streamChat.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> }
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second.messages[2]!.content).toContain('not the JSON object')
  })

  it('never takes questions after answers: it asks for the brief', async () => {
    replies(
      JSON.stringify({ kind: 'questions', questions: [{ question: 'Again?', options: ['a', 'b'] }] }),
      brief('Fix the text paste crash. [[@1]]')
    )
    const result = await structurePrompt(request({ answers: [{ question: 'Which paste?', answer: 'Text' }] }))
    expect(result).toMatchObject({ kind: 'brief', brief: 'Fix the text paste crash. [[@1]]' })
    const first = mocks.streamChat.mock.calls[0]![0] as { messages: Array<{ content: string }> }
    expect(first.messages[0]!.content).toContain('<answers>')
  })

  it('sends back invented paths once, and marks what is still invented', async () => {
    replies(
      brief('Look at `src/utils/auth.ts` and [[@1]]. Run `pnpm lint`.'),
      brief('Look at `src/utils/auth.ts` and [[@1]]. Run `pnpm test`.')
    )
    const result = await structurePrompt(request())
    const second = mocks.streamChat.mock.calls[1]![0] as { messages: Array<{ content: string }> }
    expect(second.messages[2]!.content).toContain('`src/utils/auth.ts`, `pnpm lint`')
    expect(result).toEqual({
      kind: 'brief',
      taskType: 'bug',
      brief: 'Look at `src/utils/auth.ts` (not found in this workspace) and [[@1]]. Run `pnpm test`.',
      notFound: ['src/utils/auth.ts']
    })
  })

  it('puts back a chip the model dropped', async () => {
    replies(brief('Fix the paste crash.'))
    await expect(structurePrompt(request())).resolves.toMatchObject({ brief: 'Fix the paste crash. [[@1]]' })
  })

  it('reuses the brief for the exact same request, and Try again asks afresh', async () => {
    replies(brief('First. [[@1]]'), brief('Second. [[@1]]'))
    const req = request()
    await structurePrompt(req)
    await expect(structurePrompt({ ...req, requestId: 'other' })).resolves.toMatchObject({ brief: 'First. [[@1]]', reused: true })
    await expect(structurePrompt({ ...req, force: true })).resolves.toMatchObject({ brief: 'Second. [[@1]]' })
    expect(mocks.streamChat).toHaveBeenCalledTimes(2)
  })

  it('stops when cancelled', async () => {
    let release: () => void = () => undefined
    mocks.streamChat.mockImplementationOnce(async function* (req: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => {
        release = resolve
        req.signal.addEventListener('abort', () => resolve())
      })
      if (req.signal.aborted) throw new Error('aborted')
      yield { type: 'text', text: brief('late') }
    })
    const req = request({ requestId: 'cancel-me' })
    const pending = structurePrompt(req)
    await vi.waitFor(() => expect(mocks.streamChat).toHaveBeenCalled())
    expect(cancelPromptStructure('cancel-me')).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    release()
    expect(cancelPromptStructure('cancel-me')).toBe(false)
  })

  it('says why when there is no model to ask, and never throws', async () => {
    mocks.getSettings.mockReturnValue({ provider: 'openai', model: 'gpt-5' })
    await expect(structurePrompt(request())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'No API key configured for openai'
    })
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('gives up on a model error without a retry', async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'error', message: 'boom' }
    })
    await expect(structurePrompt(request())).resolves.toEqual({ kind: 'unavailable', reason: 'The model returned an error' })
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
  })
})
