/**
 * Reliability survival e2e: orphan resume, durable follow-ups, loop checkpoint,
 * and concurrent run registration — real disk/state/registry with mocked provider only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { LOOP_CHECKPOINT_FILENAME, saveLoopCheckpoint } from '@main/agent/loopCheckpoint'
import { LOOP_CHECKPOINT_VERSION } from '@shared/ipc/schemas/agent'

const userData = join(tmpdir(), `vyotiq-reliability-${process.pid}-${Date.now()}`)
const TEST_TIMEOUT_MS = 60_000

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

const { streamChat, executeTool, assembleContext } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  assembleContext: vi.fn(async (input: { messages: unknown[] }) => ({
    messages: input.messages,
    system: 'system',
    estimatedTokens: 100,
    layers: { system: 10, history: 50, tools: 20, buffer: 20 },
    overflow: false,
    anthropicNative: undefined,
    compaction: null
  }))
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (...args: unknown[]) => assembleContext(...args),
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

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { runAgent } from '@main/agent/loop'
import {
  registerRunAbort,
  resetActiveRunsForTests,
  tryRegisterRunAbort
} from '@main/agent/runRegistry'
import {
  createRun,
  flushStatusWrites,
  interruptOrphanRuns,
  loadStatus,
  syncMessages,
  updateStatus
} from '@main/agent/state'
import { hydrateFollowUpsFromDisk, saveFollowUps } from '@main/agent/followUpStore'

type CapturedEvent = { type: string; status?: string; reason?: string; message?: string }

async function drainRun(
  runId: string,
  workspace: string,
  opts?: { resume?: boolean; userContent?: string }
): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  for await (const ev of runAgent({
    runId,
    messages: opts?.resume
      ? []
      : [{ role: 'user', content: opts?.userContent ?? 'reliability survival' }],
    workspacePath: workspace,
    ...(opts?.resume ? { resume: true } : {})
  })) {
    events.push(ev as CapturedEvent)
  }
  return events
}

describe('e2e: reliability survival', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-reliability-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockClear()
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it(
    'orphan interrupt → resume completes',
    async () => {
      const FIRST_PHASE = 3
      const runId = 'e2e-orphan-resume'
      const runDir = resolveRunDir(workspace, runId)

      let streamCall = 0
      streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
        streamCall += 1
        if (streamCall <= FIRST_PHASE + 2) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `c${streamCall}`,
              name: 'read',
              arguments: JSON.stringify({ path: `orphan-f${streamCall}.ts` })
            }
          }
          yield { type: 'done', stopReason: 'tool_calls' }
          return
        }
        yield { type: 'text', text: 'resumed complete' }
        yield { type: 'done', stopReason: 'end_turn' }
      })

      const iter = runAgent({
        runId,
        messages: [{ role: 'user', content: 'orphan survival' }],
        workspacePath: workspace
      })[Symbol.asyncIterator]()

      let toolResults = 0
      while (true) {
        const { value, done } = await iter.next()
        if (done) break
        if (value?.type === 'tool_result') toolResults += 1
        if (toolResults >= FIRST_PHASE) {
          await iter.return(undefined)
          break
        }
      }

      resetActiveRunsForTests()
      await flushStatusWrites(runDir)

      expect(loadStatus(runDir)?.status).toBe('running')

      const interrupted = await interruptOrphanRuns([workspace])
      expect(interrupted).toBe(1)
      expect(loadStatus(runDir)).toMatchObject({
        status: 'cancelled',
        resumable: true,
        step: FIRST_PHASE,
        error: RUN_INTERRUPTED_ERROR
      })
      expect(existsSync(join(runDir, LOOP_CHECKPOINT_FILENAME))).toBe(true)

      registerRunAbort(runId, workspace)
      const resumeEvents = await drainRun(runId, workspace, { resume: true })

      expect(resumeEvents.at(-1)).toMatchObject({ type: 'status', status: 'done' })
      await flushStatusWrites(runDir)
      expect(loadStatus(runDir)?.status).toBe('done')
      expect(loadStatus(runDir)?.resumable).toBeUndefined()
    },
    TEST_TIMEOUT_MS
  )

  it(
    'hydrates durable follow-ups on resume and applies them in the loop',
    async () => {
      const runId = 'e2e-followup-hydrate'
      const runDir = createRun(workspace, runId, 'follow-up goal')
      syncMessages(runDir, [{ role: 'user', content: 'start' }])
      await updateStatus(runDir, { status: 'cancelled', resumable: true, step: 1 }, { sync: true })

      saveFollowUps(runDir, [
        {
          id: 'fu-resume',
          message: { role: 'user', content: 'queued after crash' },
          ready: true
        }
      ])

      let call = 0
      streamChat.mockImplementation(async function* (
        req: ProviderChatRequest
      ): AsyncGenerator<StreamChunk> {
        call += 1
        const sawFollowUp = req.messages.some(
          (m) => m.role === 'user' && String(m.content).includes('queued after crash')
        )
        if (sawFollowUp) {
          yield { type: 'text', text: 'processed follow-up' }
          yield { type: 'done', stopReason: 'end_turn' }
          return
        }
        yield { type: 'text', text: 'unexpected' }
        yield { type: 'done', stopReason: 'end_turn' }
      })

      resetActiveRunsForTests()
      registerRunAbort(runId, workspace)
      hydrateFollowUpsFromDisk(runDir, runId)

      const events = await drainRun(runId, workspace, { resume: true })

      expect(events.some((e) => e.type === 'follow_up_applied')).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
      expect(call).toBeGreaterThanOrEqual(1)

      const messagesRaw = readFileSync(join(runDir, 'messages.jsonl'), 'utf8')
      expect(messagesRaw).toContain('queued after crash')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'auto-continues truncation after resume even when checkpoint already counted continues',
    async () => {
      const runId = 'e2e-checkpoint-truncation'
      const runDir = createRun(workspace, runId, 'truncation goal')
      syncMessages(runDir, [{ role: 'user', content: 'long answer' }])
      await updateStatus(runDir, { status: 'cancelled', resumable: true, step: 3 }, { sync: true })
      saveLoopCheckpoint(runDir, {
        version: LOOP_CHECKPOINT_VERSION,
        step: 3,
        invokeId: 2,
        updatedAt: new Date().toISOString(),
        truncationContinues: 2,
        overflowRetryUsed: true
      })

      let call = 0
      streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
        call += 1
        if (call === 1) {
          yield { type: 'text', text: 'still going' }
          yield { type: 'done', stopReason: 'length' }
        } else {
          yield { type: 'text', text: 'completed' }
          yield { type: 'done', stopReason: 'stop' }
        }
      })

      registerRunAbort(runId, workspace)
      const events: CapturedEvent[] = []
      for await (const ev of runAgent({
        runId,
        messages: [],
        workspacePath: workspace,
        resume: true
      })) {
        events.push(ev)
      }

      const incomplete = events.filter((e) => e.type === 'incomplete')
      expect(incomplete.length).toBeGreaterThanOrEqual(1)
      expect(incomplete[0]?.reason).toBe('truncated')
      expect(incomplete[0]?.message).toMatch(/continuing automatically/i)
      expect(streamChat).toHaveBeenCalledTimes(2)
      expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    },
    TEST_TIMEOUT_MS
  )
})
