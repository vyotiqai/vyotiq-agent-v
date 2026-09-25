import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir, workspaceRunFeedbackPath } from '@main/storage/paths'
import type { RunFeedbackStore, RunReceipt } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-verifygate-${process.pid}-${Date.now()}`)

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

import { getWriteCheckpoint } from '@main/agent/checkpoints'
import { runAgent } from '@main/agent/loop'
import { createRun } from '@main/agent/state'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'

const DIRTY_DIAGNOSTICS =
  'src/a.ts(3,10): error TS2345: Argument of type X is not assignable to parameter of type Y.'

/** Drive a run to completion, discarding events. */
async function drain(runId: string, workspace: string): Promise<void> {
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'change a file' }],
    workspacePath: workspace
  })) {
    void ev
  }
}

function readReceipt(workspace: string, runId: string): RunReceipt {
  const raw = readFileSync(join(resolveRunDir(workspace, runId), 'receipt.json'), 'utf8')
  return JSON.parse(raw) as RunReceipt
}

function readTranscript(workspace: string, runId: string): string {
  return readFileSync(join(resolveRunDir(workspace, runId), 'messages.jsonl'), 'utf8')
}

/** The durable per-workspace store, as teardown actually left it on disk. */
function readRunFeedback(workspace: string): RunFeedbackStore | null {
  const path = workspaceRunFeedbackPath(workspace)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RunFeedbackStore) : null
}

/**
 * One step that edits, then a closing text turn. `after` optionally inserts a
 * check tool call in between.
 */
function mockEditThen(after?: { name: string; content: string }): void {
  let call = 0
  streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
    call += 1
    if (call === 1) {
      yield {
        type: 'tool_call',
        toolCall: { id: 'c1', name: 'edit', arguments: '{"path":"a.ts","diff":"x"}' }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
      return
    }
    if (call === 2 && after) {
      yield { type: 'tool_call', toolCall: { id: 'c2', name: after.name, arguments: '{}' } }
      yield { type: 'done', stopReason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'done, file changed' }
    yield { type: 'done', stopReason: 'stop' }
  })
  executeTool.mockImplementation(async (name: string) => {
    if (after && name === after.name) {
      return { ok: true, summary: 'check', content: after.content }
    }
    return { ok: true, summary: 'edited', content: 'Applied 1 change to a.ts' }
  })
}

describe('runAgent verification gate (observe-only)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-verifygate-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('records a would-fire verdict when a turn edits and never checks', async () => {
    mockEditThen()
    const runId = 'gate-unverified'
    await drain(runId, workspace)

    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  it('folds the finished run into the durable workspace store', async () => {
    // The teardown write is the whole of phase C1: without it the store is
    // correct and permanently empty. Nothing else in the suite executes it.
    mockEditThen()
    const runId = 'gate-store-write'
    await drain(runId, workspace)

    const store = readRunFeedback(workspace)
    expect(store?.entries).toHaveLength(1)
    expect(store?.entries[0]).toMatchObject({
      runId,
      status: 'done',
      // The gate verdict rides along, so a later run can see the run finished
      // with files changed and nothing checked.
      unchecked: true
    })
  })

  it('does not mark the run unchecked when a clean check followed the edit', async () => {
    mockEditThen({ name: 'diagnostics', content: 'No diagnostics found.' })
    const runId = 'gate-store-checked'
    await drain(runId, workspace)

    const entry = readRunFeedback(workspace)?.entries[0]
    expect(entry).toMatchObject({ runId, status: 'done' })
    expect(entry?.unchecked).toBeUndefined()
  })

  it('records one entry per run, not one per interim receipt write', async () => {
    mockEditThen()
    await drain('gate-store-a', workspace)
    mockEditThen()
    await drain('gate-store-b', workspace)

    const store = readRunFeedback(workspace)
    expect(store?.entries.map((e) => e.runId)).toEqual(['gate-store-b', 'gate-store-a'])
  })

  it('injects no synthetic turn while the gate is observe-only', async () => {
    mockEditThen()
    const runId = 'gate-observe-only'
    await drain(runId, workspace)

    // The whole point of phase A: the verdict is recorded, behaviour is not
    // changed. A synthetic protocol turn here would be the armed gate.
    expect(readTranscript(workspace, runId)).not.toContain('"synthetic":true')
    expect(streamChat).toHaveBeenCalledTimes(2)
  })

  it('clears the verdict once a clean check follows the edit', async () => {
    mockEditThen({ name: 'diagnostics', content: 'No diagnostics found.' })
    const runId = 'gate-verified'
    await drain(runId, workspace)

    expect(readReceipt(workspace, runId).verificationGate).toEqual({ wouldFire: false })
  })

  it('still reports unverified when the check itself failed', async () => {
    mockEditThen({ name: 'diagnostics', content: DIRTY_DIAGNOSTICS })
    const runId = 'gate-check-failed'
    await drain(runId, workspace)

    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'check_failed'
    })
  })

  it('fires on a mutation that never passed through an edit tool', async () => {
    // The reason the tracker reconciles against the write checkpoint at all.
    // A terminal redirect, an MCP writer, a merge or a watched out-of-band
    // edit all reach the checkpoint without any edit-family tool call, so a
    // gate keyed on tool names stays silent on exactly the cases where a
    // check matters most.
    const runId = 'gate-opaque-write'
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'terminal', arguments: '{"command":"sed -i s/a/b/ a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'rewrote it in the shell' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockImplementation(async () => {
      // Stands in for the terminal mutation watcher, which is what actually
      // reaches the checkpoint on this path.
      const cp = getWriteCheckpoint(resolveRunDir(workspace, runId))
      expect(cp).toBeTruthy()
      await cp?.recordObservedMutation('a.ts', 'modified')
      return { ok: true, summary: 'ran', content: 'exit_code: 0' }
    })

    await drain(runId, workspace)

    const verdict = readReceipt(workspace, runId).verificationGate
    expect(verdict).toMatchObject({ wouldFire: true, reason: 'never_checked' })
    // No edit-family call carried a path, so the witness list is empty even
    // though the turn definitely mutated — `paths` is a sample, not the set.
    expect(verdict?.paths ?? []).toEqual([])
  })

  it('does not report a would-fire verdict for an inline-instance run', async () => {
    // Was a plan-mode run: Plan is merged into Agent, so the guarded-off cases
    // left are Ask (which cannot edit at all, making the check vacuous) and an
    // inline instance, which CAN edit. The invariant is unchanged —
    // recomputing the verdict at teardown instead of reusing the guarded one
    // would report a phantom fire and inflate the rate this phase measures.
    mockEditThen()
    const runId = 'gate-inline-instance'
    createRun(workspace, runId, 'edit a change', { mode: 'agent', inlineInstance: true })
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'edit a change' }],
      workspacePath: workspace,
      mode: 'agent'
    })) {
      void ev
    }

    const receipt = readReceipt(workspace, runId)
    // Non-vacuous: the edit really landed and was never checked, so an
    // unguarded verdict WOULD have reported a fire here. Only the guard
    // suppresses it.
    expect(receipt.toolStats.byName.edit).toMatchObject({ ok: 1 })
    expect(receipt.verificationGate).toEqual({ wouldFire: false })
  })

  it('never fires on a read-only turn', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'here is what it says' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'gate-readonly'
    await drain(runId, workspace)

    expect(readReceipt(workspace, runId).verificationGate).toEqual({ wouldFire: false })
  })
})
