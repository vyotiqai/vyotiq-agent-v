import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AgentEvent } from '@shared/ipc'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-compact-utility-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userData : join(tmpdir(), name)),
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

const state = vi.hoisted(() => ({ utilityModel: null as null | { provider: string; model: string } }))

vi.mock('@main/settings/settings', async () => {
  const { DEFAULT_SETTINGS } = await import('@shared/ipc')
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS, provider: 'ollama', model: 'task-model', utilityModel: state.utilityModel }),
    readLegacyWorkspacePath: () => null
  }
})

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/workspace/workspaces', () => ({
  findWorkspaceSettingsOverride: () => null,
  readWorkspacesState: () => ({ settingsOverridesByPath: {} })
}))

const calls = vi.hoisted(() => ({ models: [] as string[] }))

vi.mock('@main/agent/providers', () => ({
  getProvider: (id: string) => ({
    id,
    listModels: async () => [],
    streamChat: async function* (req: { model: string }): AsyncGenerator<StreamChunk> {
      calls.models.push(req.model)
      yield { type: 'text', text: '## Summary\nThe user asked for a refactor of the parser; the agent read parser.ts and edited it.' }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 900, outputTokens: 60 } }
    }
  })
}))

vi.mock('@main/agent/modelResolve', () => ({
  resolveModelInfo: async (_provider: string, id: string) => ({
    id,
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false
  })
}))

import { compactRunNow } from '@main/agent/compactRun'
import { appendMessage, createRun } from '@main/agent/state'
import { flushMessageAppends } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

/**
 * Compaction's summary is the side call a cheaper model can write. The task's
 * model still decides what is kept; the utility model writes the summary and
 * is the one billed for it.
 */
describe('compaction with a utility model', () => {
  let workspace: string
  const runId = 'compact-utility'

  beforeEach(async () => {
    workspace = join(tmpdir(), `vyotiq-compact-utility-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    calls.models = []
    createRun(workspace, runId, 'Refactor the parser')
    const dir = resolveRunDir(workspace, runId)
    for (let i = 0; i < 8; i += 1) {
      await appendMessage(dir, { role: 'user', content: `Turn ${i}: please keep refactoring the parser module, step ${i}.` })
      await appendMessage(dir, { role: 'assistant', content: `Done with step ${i} of the parser refactor; next I will continue.` })
    }
    await flushMessageAppends(dir)
  })

  afterEach(() => {
    state.utilityModel = null
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('writes the summary with the utility model and bills it there', async () => {
    state.utilityModel = { provider: 'ollama', model: 'small-model' }
    const events: AgentEvent[] = []
    await compactRunNow({ workspacePath: workspace, runId, onEvent: (ev) => events.push(ev) })
    expect(calls.models.length).toBeGreaterThan(0)
    expect(new Set(calls.models)).toEqual(new Set(['small-model']))
    const aux = events.filter((ev) => ev.type === 'aux_usage')
    expect(aux.length).toBeGreaterThan(0)
    expect(aux.every((ev) => ev.type === 'aux_usage' && ev.model === 'small-model')).toBe(true)
  }, 60_000)

  it('uses the task model when no utility model is set', async () => {
    await compactRunNow({ workspacePath: workspace, runId })
    expect(new Set(calls.models)).toEqual(new Set(['task-model']))
  }, 60_000)
})
