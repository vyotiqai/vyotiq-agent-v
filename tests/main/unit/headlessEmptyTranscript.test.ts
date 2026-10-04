import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-headless-empty-'))
const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-headless-ws-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

const startAgentRunInBackground = vi.hoisted(() => vi.fn())

// The loop is the heavyweight; runTask only needs an id from it.
vi.mock('@main/agent/loop', () => ({ createRunId: () => 'run-empty-transcript' }))
// Not reachable from a test run, and each pulls a real subsystem.
vi.mock('@main/agent/startAgentRun', () => ({ startAgentRunInBackground }))
vi.mock('@main/git/taskWorktrees', () => ({ createTaskWorktree: vi.fn() }))
vi.mock('@main/agent/toolApproval', () => ({
  resolveToolApproval: vi.fn(),
  isAutonomousHighRiskTool: () => false
}))
vi.mock('@main/agent/agentQuestion', () => ({
  resolveAgentQuestion: vi.fn(),
  rejectAgentQuestion: vi.fn()
}))

import { IPC } from '@shared/channels'
import { appendEvent, createRun, updateStatus } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'
import { EMPTY_TRANSCRIPT_ERROR, emptyTranscriptError } from '@main/headless/outcome'
import { runHeadlessTask } from '@main/headless/runTask'

const runDir = resolveRunDir(workspace, 'run-empty-transcript')
const status = () => JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8'))
const bytes = (name: string): number => statSync(join(runDir, name)).size
const names = (): string[] => readdirSync(runDir).sort()

/**
 * A run that reaches `done` the way the fixture path does: the stream reports
 * the terminal status, `status.json` is written, and not one event or message
 * row is ever appended — the shape the disk audit found in three run dirs.
 */
function stubRunThatWritesNothing(): void {
  startAgentRunInBackground.mockImplementation(
    async (input: {
      runId: string
      workspacePath: string
      invokeId: number
      wc: { send: (channel: string, payload: unknown) => void }
      agentInput: { mode: 'agent' | 'ask'; messages: { role: string; content: string }[] }
    }) => {
      createRun(input.workspacePath, input.runId, input.agentInput.messages[0]?.content ?? '', {
        mode: input.agentInput.mode
      })
      await updateStatus(resolveRunDir(input.workspacePath, input.runId), { status: 'done', step: 0 }, { sync: true })
      input.wc.send(IPC.chatEvent, {
        type: 'status',
        runId: input.runId,
        invokeId: input.invokeId,
        status: 'done'
      })
    }
  )
}

/** The ordinary path: the same terminal status, with a transcript behind it. */
function stubRunThatWritesTranscript(): void {
  startAgentRunInBackground.mockImplementation(
    async (input: {
      runId: string
      workspacePath: string
      invokeId: number
      wc: { send: (channel: string, payload: unknown) => void }
      agentInput: { mode: 'agent' | 'ask'; messages: { role: string; content: string }[] }
    }) => {
      const dir = createRun(input.workspacePath, input.runId, input.agentInput.messages[0]?.content ?? '', {
        mode: input.agentInput.mode
      })
      appendEvent(dir, { type: 'status', runId: input.runId, invokeId: input.invokeId, status: 'running' })
      appendEvent(dir, {
        type: 'assistant_message',
        runId: input.runId,
        content: 'Two files.',
        invokeId: input.invokeId
      })
      appendEvent(dir, { type: 'status', runId: input.runId, invokeId: input.invokeId, status: 'done' })
      await updateStatus(dir, { status: 'done', step: 1 }, { sync: true })
      input.wc.send(IPC.chatEvent, {
        type: 'status',
        runId: input.runId,
        invokeId: input.invokeId,
        status: 'done'
      })
    }
  )
}

const ask = () =>
  runHeadlessTask({
    workspacePath: workspace,
    prompt: 'What files are here?',
    mode: 'ask',
    approval: 'deny',
    onQuestion: 'answer'
  })

describe('emptyTranscriptError', () => {
  it('names the gap for a record with no bytes and stays quiet for one that has them', () => {
    expect(emptyTranscriptError(0)).toBe(EMPTY_TRANSCRIPT_ERROR)
    expect(emptyTranscriptError(1)).toBeUndefined()
  })
})

describe('runHeadlessTask and an empty record', () => {
  it('does not report done for a run whose transcript holds nothing', async () => {
    stubRunThatWritesNothing()
    const result = await ask()

    // What the audit found on disk: an empty transcript behind `status: done`.
    expect(bytes('messages.jsonl')).toBe(0)
    expect(bytes('events.jsonl')).toBe(0)

    // What the caller is told, and what the record now says. `RunStatus` has no
    // `failed` (src/shared/ipc/schemas/agent.ts:173) — the record says `error`
    // with the reason, the headless result says `failed`.
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
    expect(result.error).toBe(EMPTY_TRANSCRIPT_ERROR)
    expect(status()).toMatchObject({ status: 'error', step: 0, error: EMPTY_TRANSCRIPT_ERROR })
  })

  it('leaves a run that wrote its transcript reported as done', async () => {
    stubRunThatWritesTranscript()
    const result = await ask()

    expect(names()).toContain('events.jsonl')
    expect(bytes('events.jsonl')).toBeGreaterThan(0)
    expect(result.status).toBe('done')
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
    expect(status()).toMatchObject({ status: 'done', step: 1 })
    expect(status().error).toBeUndefined()
  })
})