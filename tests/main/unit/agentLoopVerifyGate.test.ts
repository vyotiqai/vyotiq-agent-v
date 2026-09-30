import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
import { resetActiveRunsForTests, cancelRun, enqueueFollowUp } from '@main/agent/runRegistry'

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

type ScriptedCall = { name: string; args?: Record<string, unknown>; ok?: boolean; content: string }

/**
 * Scripted turns: each entry is one model turn — a tool call, or `null` for a
 * closing text turn. Turns past the script end with text. Tool results come
 * from the call's own scripted content; the first call is always the edit.
 */
function mockTurns(turns: Array<ScriptedCall | null>): void {
  let call = 0
  streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
    const turn = turns[call]
    call += 1
    if (turn) {
      yield {
        type: 'tool_call',
        toolCall: { id: `c${call}`, name: turn.name, arguments: JSON.stringify(turn.args ?? {}) }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
      return
    }
    yield { type: 'text', text: 'done, file changed' }
    yield { type: 'done', stopReason: 'stop' }
  })
  executeTool.mockImplementation(async (name: string, argsJson: string) => {
    const turn = turns.find((t) => t?.name === name && JSON.stringify(t.args ?? {}) === argsJson)
    if (turn) return { ok: turn.ok ?? true, summary: name, content: turn.content }
    return { ok: true, summary: name, content: 'ok' }
  })
}

const EDIT: ScriptedCall = { name: 'edit', args: { path: 'a.ts', diff: 'x' }, content: 'Applied 1 change to a.ts' }

/** A no-op step, for runs that need to reach the first interim-receipt write. */
const READ: ScriptedCall = { name: 'read', args: { path: 'a.ts' }, content: 'file body' }

/** One step that edits, then a closing text turn; `after` inserts a check between. */
function mockEditThen(after?: { name: string; content: string }): void {
  mockTurns(after ? [EDIT, { name: after.name, content: after.content }] : [EDIT])
}

function nudgesIn(workspace: string, runId: string): number {
  return readTranscript(workspace, runId)
    .split('\n')
    .filter((line) => line.includes('"synthetic":true') && line.includes('Verification:')).length
}

/**
 * Every distinct `receipt.json` the run wrote, in order, the last one re-read
 * after teardown. The interim write is awaited inside the step boundary, so any
 * event yielded after it already sees the new file — the live receipt a panel
 * would be reading.
 */
async function receiptSnapshots(workspace: string, runId: string): Promise<RunReceipt[]> {
  const path = join(resolveRunDir(workspace, runId), 'receipt.json')
  const out: RunReceipt[] = []
  let last = ''
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'change a file' }],
    workspacePath: workspace
  })) {
    void ev
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue // no receipt yet — the first write happens inside the run
    }
    if (raw === last) continue
    last = raw
    out.push(JSON.parse(raw) as RunReceipt)
  }
  if (existsSync(path)) {
    const final = readFileSync(path, 'utf8')
    if (final !== last) out.push(JSON.parse(final) as RunReceipt)
  }
  return out
}

/** Pre-seed `events.jsonl` head rows, then bury them under `filler` big rows. */
function seedEvents(workspace: string, runId: string, head: unknown[], filler: number): void {
  // 800 × 2KB is the interim tail's byte budget (state.ts:951), so filler big
  // enough to exceed it is what a bounded read would have dropped.
  const pad = 'x'.repeat(2200)
  const rows = [
    ...head,
    ...Array.from({ length: filler }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString(),
      event: { type: 'tool_progress', runId, parentToolCallId: `p${i}`, kind: 'text', text: pad }
    }))
  ]
  writeFileSync(
    join(resolveRunDir(workspace, runId), 'events.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  )
}

/** The step-boundary (live) receipts of a run, as a panel would read them. */
function interimReceipts(snapshots: RunReceipt[]): RunReceipt[] {
  return snapshots.filter((r) => r.status === 'running' && r.step >= 5)
}

describe('runAgent verification gate (armed)', () => {
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

  it('nudges once when a turn edits and never checks, then lets the run end', async () => {
    mockEditThen()
    const runId = 'gate-unverified'
    await drain(runId, workspace)

    // edit, answer, nudge → answer again unchecked: one nudge, never a second.
    expect(nudgesIn(workspace, runId)).toBe(1)
    expect(streamChat).toHaveBeenCalledTimes(3)
    expect(readTranscript(workspace, runId)).toContain('no test, typecheck or lint run has passed')
    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'never_checked',
      nudged: true,
      paths: ['a.ts']
    })
  })

  it('records the run as checked when it checks after the nudge', async () => {
    // edit → answer → nudge → clean diagnostics → answer.
    mockTurns([EDIT, null, { name: 'diagnostics', content: 'No diagnostics found.' }])
    const runId = 'gate-checked-after-nudge'
    await drain(runId, workspace)

    expect(nudgesIn(workspace, runId)).toBe(1)
    // The final state, not the first firing: the run ended checked.
    expect(readReceipt(workspace, runId).verificationGate).toEqual({ wouldFire: false, nudged: true })
    expect(readRunFeedback(workspace)?.entries[0]?.unchecked).toBeUndefined()
  })

  it('folds the finished run into the durable workspace store', async () => {
    mockEditThen()
    const runId = 'gate-store-write'
    await drain(runId, workspace)

    const store = readRunFeedback(workspace)
    expect(store?.entries).toHaveLength(1)
    expect(store?.entries[0]).toMatchObject({
      runId,
      status: 'done',
      // Still unchecked after the nudge, so the verdict rides along.
      unchecked: true
    })
  })

  it('does not nudge or mark the run unchecked when a clean check followed the edit', async () => {
    mockEditThen({ name: 'diagnostics', content: 'No diagnostics found.' })
    const runId = 'gate-store-checked'
    await drain(runId, workspace)

    expect(nudgesIn(workspace, runId)).toBe(0)
    expect(readReceipt(workspace, runId).verificationGate).toEqual({ wouldFire: false })
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

  it('nudges to fix a check that failed', async () => {
    mockEditThen({ name: 'diagnostics', content: DIRTY_DIAGNOSTICS })
    const runId = 'gate-check-failed'
    await drain(runId, workspace)

    expect(readTranscript(workspace, runId)).toContain('did not pass')
    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'check_failed',
      nudged: true
    })
  })

  it('counts a failing test run after a clean typecheck as a failed check', async () => {
    mockTurns([
      EDIT,
      { name: 'diagnostics', content: 'No diagnostics found.' },
      {
        name: 'run_tests',
        ok: false,
        content: 'command: pnpm run test\nexit: 1\nTests: 3 passed, 1 failed (exit 1)'
      }
    ])
    const runId = 'gate-failing-tests'
    await drain(runId, workspace)

    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'check_failed'
    })
  })

  it('counts a test run in the terminal as a check', async () => {
    mockTurns([
      EDIT,
      {
        name: 'terminal',
        args: { command: 'pnpm vitest run tests/a.test.ts' },
        content: 'cwd: /ws\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n\nexit_code: 0'
      }
    ])
    const runId = 'gate-terminal-check'
    await drain(runId, workspace)

    expect(nudgesIn(workspace, runId)).toBe(0)
    expect(readReceipt(workspace, runId).verificationGate).toEqual({ wouldFire: false })
  })

  it('does not count a run_tests call that ran no test runner', async () => {
    mockTurns([
      EDIT,
      { name: 'run_tests', args: { command: 'python --version' }, content: 'command: python --version\n\nPython 3.12.1' }
    ])
    const runId = 'gate-run-tests-not-a-test'
    await drain(runId, workspace)

    expect(nudgesIn(workspace, runId)).toBe(1)
    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({ wouldFire: true, reason: 'never_checked' })
  })

  it('fires on a mutation that never passed through an edit tool', async () => {
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

  it('nudges an inline instance too', async () => {
    // Children wrote 45 of 50 code-writing runs measured; the parent only
    // sees their summary, so the child is where the check has to happen.
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

    expect(nudgesIn(workspace, runId)).toBe(1)
    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({ wouldFire: true, nudged: true })
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

    expect(nudgesIn(workspace, runId)).toBe(0)
    expect(readReceipt(workspace, runId).verificationGate).toEqual({ wouldFire: false })
  })

  // The gate verdict latched at a turn end and was replayed by the terminal
  // receipt write, so a run that kept working after a clean check and then got
  // cancelled with a fresh mutation on disk recorded the pass it no longer had.
  it('re-judges the tracker when a cancelled run mutated after its last check', async () => {
    const runId = 'gate-stale-verdict-cancel'
    let turn = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      turn += 1
      if (turn === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'edit', arguments: JSON.stringify(EDIT.args) }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (turn === 2) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c2', name: 'diagnostics', arguments: '{}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (turn === 3) {
        // Queued before this turn ends: the gate branch below judges the clean
        // state and latches `{ wouldFire: false }`, then the follow-up keeps the
        // run going instead of letting it end.
        expect(enqueueFollowUp(runId, { role: 'user', content: 'now sed the file' }).ok).toBe(true)
        yield { type: 'text', text: 'edited and checked' }
        yield { type: 'done', stopReason: 'stop' }
        return
      }
      yield {
        type: 'tool_call',
        toolCall: {
          id: 'c4',
          name: 'terminal',
          arguments: JSON.stringify({ command: 'sed -i s/a/b/ a.ts' })
        }
      }
      yield { type: 'done', stopReason: 'tool_calls' }
    })
    executeTool.mockImplementation(async (name: string) => {
      if (name === 'diagnostics') {
        return { ok: true, summary: name, content: 'No diagnostics found.' }
      }
      if (name === 'terminal') {
        // Stands in for the terminal mutation watcher — the only thing that
        // reaches the write checkpoint for a `sed -i`.
        const cp = getWriteCheckpoint(resolveRunDir(workspace, runId))
        expect(cp).toBeTruthy()
        await cp?.recordObservedMutation('a.ts', 'modified')
        // The user presses Stop while that write is the newest thing the run did.
        expect(cancelRun(runId)).toBe(true)
        return { ok: true, summary: name, content: 'exit_code: 0' }
      }
      return { ok: true, summary: name, content: EDIT.content }
    })

    await drain(runId, workspace)

    // A real cancel, not a `stopReason: 'stop'` end: the receipt says so.
    expect(readReceipt(workspace, runId).status).toBe('cancelled')
    expect(readReceipt(workspace, runId).verificationGate).toMatchObject({
      wouldFire: true,
      reason: 'never_checked'
    })
  })

  // The interim receipt used to be written with no `verificationGate` at all, so
  // a live panel and the receipt the run left behind disagreed on the verdict.
  // `persistInterimReceipt` first writes at step 5 (RECEIPT_PERSIST_EVERY_STEPS),
  // so the run is scripted past that.
  it('writes the same verification gate into the interim receipt as the final one', async () => {
    // edit → clean check → three more steps, then the closing turn the gate
    // branch judges. Verified at step 2, so both writes report no fire.
    mockTurns([
      EDIT,
      { name: 'diagnostics', content: 'No diagnostics found.' },
      READ,
      READ,
      READ,
      null
    ])
    const runId = 'gate-interim-parity'
    const snapshots = await receiptSnapshots(workspace, runId)
    const live = interimReceipts(snapshots)
    const final = snapshots[snapshots.length - 1]

    expect(live.length).toBeGreaterThan(0)
    expect(final.status).toBe('done')
    // Same expression on both writes: the guarded turn-end verdict.
    expect(final.verificationGate).toEqual({ wouldFire: false })
    for (const receipt of live) {
      expect(receipt.verificationGate).toEqual(final.verificationGate)
    }
  })

  // A step-boundary receipt read a bounded 800-event tail while the terminal
  // write read the whole history, so tokenUsage and wroteFiles were computed
  // from different event sets for the same run.
  it('derives the interim receipt from the same event window as the final one', async () => {
    const runId = 'gate-interim-window'
    createRun(workspace, runId, 'change a file')
    seedEvents(
      workspace,
      runId,
      [
        {
          at: '2026-01-01T00:00:00.500Z',
          event: {
            type: 'step_usage',
            runId,
            step: 1,
            inputTokens: 1000,
            outputTokens: 50
          }
        },
        {
          at: '2026-01-01T00:00:01.000Z',
          event: {
            type: 'writes_checkpoint',
            runId,
            checkpointId: 'cp-early',
            files: [{ path: 'src/early.ts', action: 'modified', undoable: true }]
          }
        }
      ],
      // Past the tail's 800 × 2KB byte budget (state.ts:951), so a bounded
      // read drops both head rows and the receipt sees neither.
      900
    )

    mockTurns([READ, READ, READ, READ, READ, null])
    const snapshots = await receiptSnapshots(workspace, runId)
    const live = interimReceipts(snapshots)
    const final = snapshots[snapshots.length - 1]

    expect(live.length).toBeGreaterThan(0)
    // The head rows are only in the receipt if the full history was read.
    expect(final.tokenUsage?.inputTokens).toBe(1000)
    expect(final.wroteFiles).toContain('src/early.ts')
    for (const receipt of live) {
      expect(receipt.tokenUsage).toEqual(final.tokenUsage)
      expect(receipt.wroteFiles).toEqual(final.wroteFiles)
    }
  })
})
