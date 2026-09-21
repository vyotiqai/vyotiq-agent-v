/**
 * P1-3 endurance audit: long healthy tool loops, concurrent runs, crash-resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import { LONG_RUN_STEP_HINT_THRESHOLD } from '@shared/utils/tokenCost'
import { RUN_RECEIPT_FILENAME } from '@main/agent/runReceipt'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { LOOP_CHECKPOINT_FILENAME } from '@main/agent/loopCheckpoint'

const userData = join(tmpdir(), `vyotiq-endurance-${process.pid}-${Date.now()}`)
const AUDIT_TIMEOUT_MS = 180_000
const HEAP_DELTA_CAP_BYTES = 80 * 1024 * 1024

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
import { listActiveRuns, registerRunAbort, resetActiveRunsForTests, tryRegisterRunAbort } from '@main/agent/runRegistry'
import { flushStatusWrites, interruptOrphanRuns, loadStatus } from '@main/agent/state'

type CapturedEvent = {
  type: string
  status?: string
  code?: string
  message?: string
}

function countMessagesLines(runDir: string): number {
  const p = join(runDir, 'messages.jsonl')
  if (!existsSync(p)) return 0
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).length
}

function runTagFromRequest(req: ProviderChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i]
    if (msg?.role !== 'user') continue
    const text = String(msg.content ?? '')
    const match = text.match(/endurance concurrent (run-[abc])/)
    if (match?.[1]) return match[1]
  }
  return 'default'
}

function installHealthyToolLoopMock(totalToolSteps: number, pathPrefix = 'f'): void {
  let call = 0
  streamChat.mockImplementation(async function* (
    req: ProviderChatRequest
  ): AsyncGenerator<StreamChunk> {
    call += 1
    const tag = runTagFromRequest(req)
    if (call <= totalToolSteps) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: `c${tag}-${call}`,
          name: 'read',
          arguments: JSON.stringify({ path: `${pathPrefix}${tag}-${call}.ts` })
        }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: `finished after ${totalToolSteps} tool steps` }
    yield { type: 'done', stopReason: 'end_turn' }
  })
}

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
      : [{ role: 'user', content: opts?.userContent ?? 'endurance marathon' }],
    workspacePath: workspace,
    ...(opts?.resume ? { resume: true } : {})
  })) {
    events.push(ev as CapturedEvent)
  }
  return events
}

describe('audit: endurance run', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-endurance-ws-${process.pid}-${Date.now()}`)
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
    'completes a 120-step healthy tool loop with durable step/receipt/messages',
    async () => {
      const TARGET_STEPS = 120
      expect(TARGET_STEPS).toBeGreaterThan(LONG_RUN_STEP_HINT_THRESHOLD)

      // Observational guard — not proof of multi-day stability.
      const heapBefore = process.memoryUsage().heapUsed

      installHealthyToolLoopMock(TARGET_STEPS)

      const runId = 'endurance-marathon'
      const runDir = resolveRunDir(workspace, runId)
      const events: CapturedEvent[] = []
      let prevMessageLines = 0

      for await (const ev of runAgent({
        runId,
        messages: [{ role: 'user', content: 'endurance marathon' }],
        workspacePath: workspace
      })) {
        events.push(ev as CapturedEvent)
        const lineCount = countMessagesLines(runDir)
        expect(lineCount).toBeGreaterThanOrEqual(prevMessageLines)
        prevMessageLines = lineCount
      }

      const heapAfter = process.memoryUsage().heapUsed
      expect(heapAfter - heapBefore).toBeLessThan(HEAP_DELTA_CAP_BYTES)

      expect(events.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
      expect(events.filter((e) => e.type === 'status' && e.status === 'error')).toHaveLength(0)
      expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })

      expect(streamChat).toHaveBeenCalledTimes(TARGET_STEPS + 1)
      expect(executeTool).toHaveBeenCalledTimes(TARGET_STEPS)

      await flushStatusWrites(runDir)
      const status = loadStatus(runDir)
      expect(status?.step).toBeGreaterThanOrEqual(TARGET_STEPS)
      expect(status?.status).toBe('done')

      const receiptPath = join(runDir, RUN_RECEIPT_FILENAME)
      expect(existsSync(receiptPath)).toBe(true)
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { step: number }
      expect(receipt.step).toBeGreaterThanOrEqual(TARGET_STEPS)

      expect(countMessagesLines(runDir)).toBeGreaterThan(0)
    },
    AUDIT_TIMEOUT_MS
  )

  it(
    'isolates three concurrent 30-step runs without cross-contamination',
    async () => {
      const STEPS_PER_RUN = 30
      const runIds = ['run-a', 'run-b', 'run-c'] as const
      const counters: Record<string, number> = { 'run-a': 0, 'run-b': 0, 'run-c': 0 }

      streamChat.mockImplementation(async function* (
        req: ProviderChatRequest
      ): AsyncGenerator<StreamChunk> {
        const tag = runTagFromRequest(req)
        counters[tag] = (counters[tag] ?? 0) + 1
        const n = counters[tag]
        if (n <= STEPS_PER_RUN) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `c${tag}-${n}`,
              name: 'read',
              arguments: JSON.stringify({ path: `${tag}-f${n}.ts` })
            }
          }
          yield { type: 'done', stopReason: 'tool_calls' }
          return
        }
        yield { type: 'text', text: `${tag} done` }
        yield { type: 'done', stopReason: 'end_turn' }
      })

      const results = await Promise.all(
        runIds.map((runId) =>
          drainRun(runId, workspace, { userContent: `endurance concurrent ${runId}` })
        )
      )

      for (const events of results) {
        expect(events.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
        expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
      }

      for (const runId of runIds) {
        const runDir = resolveRunDir(workspace, runId)
        const body = readFileSync(join(runDir, 'messages.jsonl'), 'utf8')
        expect(body).toContain(`endurance concurrent ${runId}`)
        for (const other of runIds) {
          if (other === runId) continue
          expect(body).not.toContain(`endurance concurrent ${other}`)
        }
      }

      expect(listActiveRuns()).toHaveLength(0)
    },
    AUDIT_TIMEOUT_MS
  )

  it(
    'resumes after a 50-step orphan interrupt for 50 more steps (100+ total)',
    async () => {
      const FIRST_PHASE = 50
      const SECOND_PHASE = 50
      const runId = 'endurance-resume'
      const runDir = resolveRunDir(workspace, runId)

      let streamCall = 0
      let releaseHang: (() => void) | undefined
      const hangGate = new Promise<void>((resolve) => {
        releaseHang = resolve
      })

      streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
        streamCall += 1
        if (streamCall === FIRST_PHASE + 1) {
          await hangGate
        }
        if (streamCall <= FIRST_PHASE + SECOND_PHASE) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `c${streamCall}`,
              name: 'read',
              arguments: JSON.stringify({ path: `resume-f${streamCall}.ts` })
            }
          }
          yield { type: 'done', stopReason: 'tool_calls' }
          return
        }
        yield { type: 'text', text: 'resumed marathon complete' }
        yield { type: 'done', stopReason: 'end_turn' }
      })

      const iter = runAgent({
        runId,
        messages: [{ role: 'user', content: 'endurance resume marathon' }],
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
      releaseHang?.()

      const midStatus = loadStatus(runDir)
      expect(midStatus?.status).toBe('running')
      expect(midStatus?.step).toBe(FIRST_PHASE)

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

      expect(resumeEvents.some((e) => e.type === 'error' && e.code === 'LOOP_SAFETY')).toBe(false)
      expect(resumeEvents.at(-1)).toMatchObject({ type: 'status', status: 'done' })

      await flushStatusWrites(runDir)
      const finalStatus = loadStatus(runDir)
      expect(finalStatus?.step).toBeGreaterThanOrEqual(FIRST_PHASE + SECOND_PHASE)
      expect(finalStatus?.resumable).toBeUndefined()
      expect(finalStatus?.status).toBe('done')
    },
    AUDIT_TIMEOUT_MS
  )
})
