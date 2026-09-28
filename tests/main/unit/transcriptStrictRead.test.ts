import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-strict-read-${process.pid}-${Date.now()}`)

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
  return { ...actual, syncMcpServers: vi.fn(async () => {}), listMcpToolDefinitions: () => [] }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
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
vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { streamChat, fsFaults } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  /** One-shot filesystem faults, matched against the call's arguments. */
  fsFaults: {
    appendFile: null as null | ((path: string, data: string) => boolean),
    readFile: null as null | ((path: string) => boolean)
  }
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      const match = fsFaults.appendFile
      if (match && match(String(args[0]), String(args[1]))) {
        fsFaults.appendFile = null
        throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
      }
      return actual.appendFile(...args)
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const match = fsFaults.readFile
      if (match && match(String(args[0]))) {
        fsFaults.readFile = null
        throw Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE' })
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile
  }
})

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      overflow: false,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

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

vi.mock('@main/agent/tools', () => ({ executeTool: vi.fn() }))

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import {
  appendMessage,
  createRun,
  flushMessageAppends,
  loadMessagesAsync,
  loadMessagesStrictAsync
} from '@main/agent/state'

function transcript(runDir: string): Array<{ role: string; content: unknown }> {
  return readFileSync(join(runDir, 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { role: string; content: unknown })
}

async function drain(gen: AsyncGenerator<unknown>): Promise<Array<{ type: string; status?: string; code?: string }>> {
  const events: Array<{ type: string; status?: string; code?: string }> = []
  for await (const ev of gen) events.push(ev as { type: string; status?: string; code?: string })
  return events
}

describe('strict transcript reads', () => {
  let workspace: string

  beforeEach(() => {
    resetActiveRunsForTests()
    streamChat.mockReset()
    fsFaults.appendFile = null
    fsFaults.readFile = null
    workspace = join(userData, `ws-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('refuses a partial transcript when an archive cannot be read', async () => {
    const runId = 'run-archive'
    const runDir = createRun(workspace, runId, 'goal', { mode: 'agent' })
    appendMessage(runDir, { role: 'user', content: 'live turn' })
    await flushMessageAppends(runDir)
    // An archive that exists but cannot be read (a directory stands in for a
    // locked file).
    mkdirSync(join(runDir, 'messages.archive.2026-01-01T00-00-00-000Z.jsonl'))

    await expect(loadMessagesStrictAsync(workspace, runId)).rejects.toThrow()
    // The best-effort reader still degrades to what it can read.
    expect((await loadMessagesAsync(workspace, runId)).map((m) => m.content)).toEqual(['live turn'])
  })

  it('refuses to read over a recorded append failure', async () => {
    const runId = 'run-append-failed'
    const runDir = createRun(workspace, runId, 'goal', { mode: 'agent' })
    fsFaults.appendFile = (path) => path.endsWith('messages.jsonl')
    appendMessage(runDir, { role: 'user', content: 'lost' })
    await expect(loadMessagesStrictAsync(workspace, runId)).rejects.toThrow(/EACCES/)
  })

  // Repro of the wipe: the empty assistant row fails to append, the turn is
  // classified empty_response, and the retry used to sync `[]` over the file.
  it('keeps the transcript when an empty turn follows a failed append', async () => {
    const runId = 'run-empty-wipe'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      fsFaults.appendFile = (path, data) =>
        path.endsWith('messages.jsonl') && data.includes('"role":"assistant"')
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await drain(
      runAgent({ runId, messages: [{ role: 'user', content: 'keep me' }], workspacePath: workspace })
    )

    const runDir = resolveRunDir(workspace, runId)
    expect(transcript(runDir).map((m) => m.content)).toEqual(['keep me'])
    // The lost append is still reported and stops the run.
    expect(events.some((e) => e.type === 'error' && e.code === 'PERSIST')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'error' })
  })

  it('stops a resume whose transcript read fails, without rewriting it', async () => {
    const runId = 'run-resume-read'
    const runDir = createRun(workspace, runId, 'goal', { mode: 'agent' })
    appendMessage(runDir, { role: 'user', content: 'first question' })
    appendMessage(runDir, { role: 'assistant', content: 'first answer' })
    await flushMessageAppends(runDir)
    const before = readFileSync(join(runDir, 'messages.jsonl'), 'utf8')

    fsFaults.readFile = (path) => path.endsWith('messages.jsonl')
    const events = await drain(
      runAgent({
        runId,
        resume: true,
        newMessages: [{ role: 'user', content: 'next question' }],
        workspacePath: workspace
      })
    )

    expect(streamChat).not.toHaveBeenCalled()
    expect(readFileSync(join(runDir, 'messages.jsonl'), 'utf8')).toBe(before)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'error' })
  })

  it('still resumes normally when the read succeeds', async () => {
    const runId = 'run-resume-ok'
    const runDir = createRun(workspace, runId, 'goal', { mode: 'agent' })
    appendMessage(runDir, { role: 'user', content: 'first question' })
    appendMessage(runDir, { role: 'assistant', content: 'first answer' })
    await flushMessageAppends(runDir)
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'second answer' }
      yield { type: 'done', stopReason: 'stop' }
    })

    await drain(
      runAgent({
        runId,
        resume: true,
        newMessages: [{ role: 'user', content: 'next question' }],
        workspacePath: workspace
      })
    )

    expect(transcript(runDir).map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'next question',
      'second answer'
    ])
  })
})

