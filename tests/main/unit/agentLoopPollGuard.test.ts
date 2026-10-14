import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-pollguard-${process.pid}-${Date.now()}`)

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

const { settingsOverride } = vi.hoisted(() => ({
  settingsOverride: {} as Record<string, unknown>
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
    ...settingsOverride
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
    assembleContext: (input: { messages: unknown[] }) => assembleContext(input),
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

// Real hold logic on a clock that moves only when the hold sleeps, so a
// 30-minute budget runs in milliseconds.
vi.mock('@main/agent/pollGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/pollGuard')>()
  return {
    ...actual,
    runPollHold: (options: Parameters<typeof actual.runPollHold>[0]) => {
      let t = 0
      return actual.runPollHold({
        ...options,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      })
    }
  }
})

import { runAgent } from '@main/agent/loop'
import { enqueueFollowUp, promoteFollowUp, resetActiveRunsForTests } from '@main/agent/runRegistry'
import {
  registerApprovalSender,
  resetToolApprovalForTests,
  resolveToolApproval
} from '@main/agent/toolApproval'

const SSH =
  'ssh -p 2222 -o BatchMode=yes dev@127.0.0.1 "pgrep -f \'podman pull\' >/dev/null && echo pulling || echo finished"'

/** What a finished foreground command looks like; the session id differs every run. */
function frame(stdout: string): string {
  return [
    `session_id: ${crypto.randomUUID()}`,
    'status: done',
    `command: ${SSH}`,
    'cwd: C:\\ws',
    'shell: powershell',
    '',
    stdout,
    'exit_code: 0'
  ].join('\n')
}

type Captured = { type: string; status?: string; kind?: string; text?: string; parentToolCallId?: string }

function requestText(request: unknown): string {
  return JSON.stringify((request as ProviderChatRequest).messages)
}

/**
 * A cleaner version of run a1dc71e2's stretches: the model polls one ssh
 * status command, step after step, until the remote pull finishes.
 */
function pollingModel(): void {
  let call = 0
  streamChat.mockImplementation(async function* (
    request: ProviderChatRequest
  ): AsyncGenerator<StreamChunk> {
    call += 1
    const seen = requestText(request)
    if (seen.includes('IMAGE_READY') || seen.includes('stop waiting')) {
      yield { type: 'text', text: 'The pull finished.' }
      yield { type: 'done', stopReason: 'stop' }
      return
    }
    yield {
      type: 'tool_call',
      toolCall: { id: `c${call}`, name: 'terminal', arguments: JSON.stringify({ command: SSH }) }
    }
    yield { type: 'done', stopReason: 'tool_calls' }
  })
}

/** The remote side: silent `pulling` answers until run `doneOnRun`. */
function remotePull(doneOnRun: number, onRun?: (run: number) => void): void {
  let runs = 0
  executeTool.mockImplementation(async () => {
    runs += 1
    onRun?.(runs)
    const out = runs >= doneOnRun ? 'IMAGE_READY' : 'pulling'
    return { ok: true, summary: 'ssh', content: frame(out) }
  })
}

async function collect(runId: string, workspace: string): Promise<Captured[]> {
  const events: Captured[] = []
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'pull the image in the VM and tell me when it is done' }],
    workspacePath: workspace
  })) {
    events.push(ev as Captured)
  }
  return events
}

function persistedMessages(workspace: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(join(resolveRunDir(workspace, runId), 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('runAgent poll guard', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-pollguard-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    resetToolApprovalForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockClear()
    for (const key of Object.keys(settingsOverride)) delete settingsOverride[key]
    // Approvals off. The default ('mutating') asks for this command, and the
    // guard never takes over a call that asks (see the approval test below).
    settingsOverride.toolApproval = { mode: 'off', allowlist: [], mcpProtection: true, rules: [] }
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('re-checks a repeated poll between steps and wakes the model when the answer changes', async () => {
    pollingModel()
    remotePull(11)
    const runId = 'poll-guard-changed'
    const events = await collect(runId, workspace)

    // Three polls by the model, eight re-checks by the harness, one closing step.
    // Without the guard this is eleven model steps.
    expect(executeTool).toHaveBeenCalledTimes(11)
    expect(streamChat).toHaveBeenCalledTimes(4)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const progress = events.filter((e) => e.type === 'tool_progress')
    expect(progress.every((e) => e.parentToolCallId === 'c3')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ kind: 'done' })
    expect(progress.at(-1)!.text).toMatch(/^Result changed · 8 re-checks over/)

    const note = persistedMessages(workspace, runId).find(
      (m) => m.role === 'user' && m.synthetic === true
    )
    expect(note?.content).toContain('[Poll hold]')
    expect(note?.content).toContain('IMAGE_READY')

    // The re-checks never reach the transcript as tool calls of their own.
    const persistedEvents = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persistedEvents.match(/"type":"tool_start"/g)).toHaveLength(3)
  })

  it('hands the call back after the budget, and holds again at once if the model repeats it', async () => {
    pollingModel()
    // 3 polls + 17 re-checks fill one 30-minute hold; the model's 4th poll
    // holds at once, and the pull finishes during that second hold.
    remotePull(25)
    const runId = 'poll-guard-budget'
    const events = await collect(runId, workspace)

    expect(executeTool).toHaveBeenCalledTimes(25)
    expect(streamChat).toHaveBeenCalledTimes(5)
    const done = events.filter((e) => e.type === 'tool_progress' && e.kind === 'done')
    expect(done.map((e) => e.text!.split(' · ')[0])).toEqual(['No change', 'Result changed'])
    const notes = persistedMessages(workspace, runId).filter((m) => m.synthetic === true)
    expect(String(notes[0]?.content)).toContain('block_until_ms')
  })

  it('never takes over a call that would ask the user first', async () => {
    settingsOverride.toolApproval = { mode: 'all', allowlist: [], mcpProtection: true }
    pollingModel()
    remotePull(6)
    const runId = 'poll-guard-approval'
    let prompts = 0
    registerApprovalSender(runId, (request) => {
      prompts += 1
      queueMicrotask(() =>
        resolveToolApproval({ requestId: request.requestId, runId, decision: 'once' })
      )
    })
    const events = await collect(runId, workspace)

    // Every poll is a model step with its own approval, exactly as before.
    expect(executeTool).toHaveBeenCalledTimes(6)
    expect(prompts).toBe(6)
    expect(streamChat).toHaveBeenCalledTimes(7)
    expect(events.some((e) => e.type === 'tool_progress')).toBe(false)
  })

  it('ends the hold when the user sends a message, and the message reaches the model', async () => {
    pollingModel()
    const runId = 'poll-guard-steer'
    remotePull(Number.POSITIVE_INFINITY, (run) => {
      if (run !== 5) return
      const queued = enqueueFollowUp(runId, { role: 'user', content: 'stop waiting, just report' })
      if (queued.ok) promoteFollowUp(runId, queued.id)
    })
    const events = await collect(runId, workspace)

    expect(executeTool).toHaveBeenCalledTimes(5)
    expect(streamChat).toHaveBeenCalledTimes(4)
    const done = events.filter((e) => e.type === 'tool_progress' && e.kind === 'done')
    expect(done.map((e) => e.text!.split(' · ')[0])).toEqual(['Stopped'])
    const messages = persistedMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && m.content === 'stop waiting, just report')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('leaves a queued (not sent-now) message for the turn end, as it would without a hold', async () => {
    pollingModel()
    const runId = 'poll-guard-queued'
    remotePull(11, (run) => {
      // Queued, not promoted: no stream interrupt fires for it.
      if (run === 5) enqueueFollowUp(runId, { role: 'user', content: 'and then summarize' })
    })
    const events = await collect(runId, workspace)

    // Same shape as the uninterrupted case: the hold runs to the change.
    expect(executeTool).toHaveBeenCalledTimes(11)
    const done = events.filter((e) => e.type === 'tool_progress' && e.kind === 'done')
    expect(done.map((e) => e.text!.split(' · ')[0])).toEqual(['Result changed'])
    const messages = persistedMessages(workspace, runId)
    expect(messages.some((m) => m.role === 'user' && m.content === 'and then summarize')).toBe(true)
  })
})
