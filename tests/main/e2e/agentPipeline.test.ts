/**
 * End-to-end agent pipeline (no Electron GUI): mocked provider drives
 * runAgent through tool calls → tool results → completion, plus mode gating
 * and cancel. Complements unit agentLoop* suites with a durable e2e surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'
import { workspaceHasEditableHarness } from '@main/agent/harnessApply'
import { SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS } from '@main/agent/executeStepTools'

const userData = join(tmpdir(), `vyotiq-e2e-adw-${process.pid}-${Date.now()}`)

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
    telemetryEnabled: false,
    autoModeSwitch: false
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({
  loadHarness: () => 'harness'
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      anthropicNative: undefined,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

const { streamChat, executeTool } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn()
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat
  }),
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
  cancelRun,
  clearRunAbort,
  registerRunAbort,
  resetActiveRunsForTests
} from '@main/agent/runRegistry'
import { executeStepToolCalls } from '@main/agent/executeStepTools'
import { assertToolAllowedInMode } from '@main/agent/tools/modePolicy'

describe('e2e agent ADW pipeline (no Electron GUI)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-e2e-adw-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('runs provider → tool → tool result → done', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 't1', name: 'read', arguments: '{"path":"note.md"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Finished reading.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'hello' })

    const runId = 'e2e-pipeline'
    const events: Array<{ type: string; status?: string; name?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'read note' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(executeTool).toHaveBeenCalled()
    expect(events.some((e) => e.type === 'tool_start' && e.name === 'read')).toBe(true)
    expect(events.some((e) => e.type === 'tool_result')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const persisted = readFileSync(join(resolveRunDir(workspace, runId), 'events.jsonl'), 'utf8')
    expect(persisted).toContain('"type":"tool_result"')
    expect(persisted).toContain('"status":"done"')
  })

  it('multi-step tool loop: edit soft-nudges diagnostics then completes', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}\n', 'utf8')
    writeFileSync(join(workspace, 'note.ts'), 'const a = 1\n', 'utf8')
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 't-edit',
            name: 'edit',
            arguments: '{"path":"note.ts","contents":"const a = 2\\n"}'
          }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      if (call === 2) {
        yield {
          type: 'tool_call',
          toolCall: { id: 't-diag', name: 'diagnostics', arguments: '{}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Verified.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    executeTool.mockImplementation(async (name: string) => {
      if (name === 'edit') return { ok: true, summary: 'edited', content: 'wrote note.ts' }
      if (name === 'diagnostics') return { ok: true, summary: 'clean', content: 'ok' }
      return { ok: true, summary: name, content: 'ok' }
    })

    const runId = 'e2e-multi-step'
    const events: Array<{ type: string; status?: string; name?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'fix note' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(executeTool.mock.calls.map((c) => c[0])).toEqual(['edit', 'diagnostics'])
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const messagesPath = join(resolveRunDir(workspace, runId), 'messages.jsonl')
    const messagesRaw = readFileSync(messagesPath, 'utf8')
    expect(messagesRaw).toContain(SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS)
    // Soft nudge only — hard verify-before-done remains an intentional product deferral.
    expect(messagesRaw).not.toMatch(/verify-before-done/i)
  })

  it('cancels an in-flight run via runRegistry', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' }
      await new Promise((r) => setTimeout(r, 200))
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const runId = 'e2e-cancel'
    const { controller, invokeId } = registerRunAbort(runId, workspace)
    const events: Array<{ type: string; status?: string }> = []
    const gen = runAgent({
      runId,
      messages: [{ role: 'user', content: 'slow' }],
      workspacePath: workspace,
      signal: controller.signal
    })

    const consume = (async () => {
      for await (const ev of gen) events.push(ev)
    })()
    await new Promise((r) => setTimeout(r, 20))
    expect(cancelRun(runId)).toBe(true)
    await consume
    clearRunAbort(runId, invokeId)

    expect(
      events.some((e) => e.type === 'status' && (e.status === 'cancelled' || e.status === 'error'))
    ).toBe(true)
  })

  it('Ask mode denies edit; Agent mode allows (mode policy gate)', () => {
    const ask = assertToolAllowedInMode('ask', 'edit', { path: 'a.ts' }, { autoModeSwitch: false })
    expect(ask.ok).toBe(false)
    const agent = assertToolAllowedInMode('agent', 'edit', { path: 'a.ts' }, { autoModeSwitch: false })
    expect(agent.ok).toBe(true)
  })

  it('rejects harness apply path when workspace has no editable harness', () => {
    expect(workspaceHasEditableHarness(workspace)).toBe(false)
    expect(workspaceHasEditableHarness(join(workspace, 'missing-root'))).toBe(false)
  })

  it('mutation step without diagnostics soft-nudges the build agent', async () => {
    writeFileSync(join(workspace, 'package.json'), '{}\n', 'utf8')
    executeTool.mockResolvedValue({ ok: true, summary: 'edited', content: 'wrote' })
    const events: Array<{ type: string }> = []
    const messages: unknown[] = []
    const outcome = await executeStepToolCalls(
      [{ id: 'e1', name: 'edit', arguments: '{"path":"x.ts","contents":"1"}' }],
      {
        runId: 'e2e-nudge',
        runDir: join(workspace, 'run'),
        workspace,
        signal: new AbortController().signal,
        appendMessage: async (m) => {
          messages.push(m)
        },
        appendEvent: (ev) => events.push(ev)
      }
    )
    expect(outcome.messages[0]?.content).toContain(SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS)
  })

  it('mutation + diagnostics in one step skips soft-nudge', async () => {
    writeFileSync(join(workspace, 'x.ts'), '1\n', 'utf8')
    executeTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    const outcome = await executeStepToolCalls(
      [
        { id: 'e1', name: 'edit', arguments: '{"path":"x.ts","contents":"2"}' },
        { id: 'd1', name: 'diagnostics', arguments: '{}' }
      ],
      {
        runId: 'e2e-nudge-skip',
        runDir: join(workspace, 'run'),
        workspace,
        signal: new AbortController().signal,
        knownPaths: new Set(['x.ts']),
        appendMessage: async () => {},
        appendEvent: () => {}
      }
    )
    const edit = outcome.messages.find((m) => m.toolCallId === 'e1')
    expect(edit?.content).not.toContain(SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS)
  })

  it('delete clears knownPaths so recreate-edit soft-warns unread', async () => {
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), '1\n', 'utf8')
    executeTool.mockImplementation(async (name: string) => {
      if (name === 'delete') {
        unlinkSync(join(workspace, 'src', 'a.ts'))
        return { ok: true, summary: 'deleted', content: 'ok' }
      }
      return { ok: true, summary: name, content: 'ok' }
    })
    const knownPaths = new Set(['src/a.ts', 'src/a.ts/nested-stale'])
    await executeStepToolCalls(
      [{ id: 'd1', name: 'delete', arguments: '{"path":"src/a.ts"}' }],
      {
        runId: 'e2e-delete',
        runDir: join(workspace, 'run'),
        workspace,
        signal: new AbortController().signal,
        knownPaths,
        appendMessage: async () => {},
        appendEvent: () => {}
      }
    )
    expect(knownPaths.has('src/a.ts')).toBe(false)
    expect(knownPaths.has('src/a.ts/nested-stale')).toBe(false)

    writeFileSync(join(workspace, 'src', 'a.ts'), '2\n', 'utf8')
    const outcome = await executeStepToolCalls(
      [{ id: 'e1', name: 'edit', arguments: '{"path":"src/a.ts","contents":"3"}' }],
      {
        runId: 'e2e-delete-edit',
        runDir: join(workspace, 'run'),
        workspace,
        signal: new AbortController().signal,
        knownPaths,
        appendMessage: async () => {},
        appendEvent: () => {}
      }
    )
    expect(outcome.messages[0]?.content).toMatch(
      /Soft warning: edited existing file\(s\) without a prior read\/grep\/glob\/codebase_search inspect: src\/a\.ts/
    )
  })

  it('soft interrupt labels tools Interrupted; hard cancel labels Cancelled', async () => {
    const runAc = new AbortController()
    const softAc = new AbortController()
    const combined =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([runAc.signal, softAc.signal])
        : runAc.signal

    executeTool.mockImplementation(async (_n, _a, _w, toolSignal: AbortSignal) => {
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const softWork = executeStepToolCalls(
      [{ id: 's1', name: 'read', arguments: '{"path":"a.ts"}' }],
      {
        runId: 'e2e-soft',
        runDir: join(workspace, 'run'),
        workspace,
        signal: combined,
        runSignal: runAc.signal,
        appendMessage: async () => {},
        appendEvent: () => {}
      }
    )
    softAc.abort()
    const softOut = await softWork
    expect(softOut.messages[0]?.content).toBe('Interrupted')

    executeTool.mockImplementation(async (_n, _a, _w, toolSignal: AbortSignal) => {
      while (!toolSignal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })
    const runAc2 = new AbortController()
    const softAc2 = new AbortController()
    const combined2 =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([runAc2.signal, softAc2.signal])
        : runAc2.signal
    const hardWork = executeStepToolCalls(
      [{ id: 'h1', name: 'read', arguments: '{"path":"a.ts"}' }],
      {
        runId: 'e2e-hard',
        runDir: join(workspace, 'run'),
        workspace,
        signal: combined2,
        runSignal: runAc2.signal,
        appendMessage: async () => {},
        appendEvent: () => {}
      }
    )
    runAc2.abort()
    const hardOut = await hardWork
    expect(hardOut.messages[0]?.content).toBe('Cancelled')
  })
})
