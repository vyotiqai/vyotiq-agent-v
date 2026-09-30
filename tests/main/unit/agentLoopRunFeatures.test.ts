import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-texttools-${process.pid}-${Date.now()}`)

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
      { id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { registerQuestionSender, resetAgentQuestionForTests, resolveAgentQuestion } from '@main/agent/agentQuestion'
import { resetHooksForTests } from '@main/agent/hooks'

type Ev = { type: string; status?: string; name?: string; content?: string; ok?: boolean }

/**
 * A local model that writes its call in its chat template's syntax instead of
 * structured tool_calls. Before, the step read as a final answer and the run
 * ended; now the call runs and the loop carries on.
 */
describe('tool calls written as text', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-texttools-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    executeTool.mockResolvedValue({ ok: true, summary: 'read a.ts', content: 'export const a = 1' })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('runs a <tool_call> the model wrote as text, then continues to the answer', async () => {
    const seen: unknown[][] = []
    let turn = 0
    streamChat.mockImplementation(async function* (req: { messages: unknown[] }): AsyncGenerator<StreamChunk> {
      turn += 1
      seen.push(req.messages)
      if (turn === 1) {
        yield { type: 'text', text: 'Reading it.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>' }
        yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }
        return
      }
      yield { type: 'text', text: 'a.ts exports a = 1.' }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }
    })

    const events: Ev[] = []
    for await (const ev of runAgent({
      runId: 'text-tools',
      messages: [{ role: 'user', content: 'What does a.ts export?' }],
      workspacePath: workspace
    })) {
      events.push(ev as Ev)
    }

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(executeTool.mock.calls[0]![0]).toBe('read')
    expect(JSON.parse(executeTool.mock.calls[0]![1] as string)).toEqual({ path: 'a.ts' })
    expect(turn).toBe(2)
    // The second request carries the call as a real assistant tool call and
    // its result — not the template text.
    const second = JSON.stringify(seen[1])
    expect(second).not.toContain('<tool_call>')
    expect(second).toContain('export const a = 1')
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
  }, 60_000)

  it('does not invent a call from a tool the step did not offer', async () => {
    let turn = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      turn += 1
      yield { type: 'text', text: 'Done: <tool_call>{"name": "format_disk", "arguments": {}}</tool_call>' }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }
    })
    for await (const ev of runAgent({
      runId: 'text-tools-unknown',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      void ev
    }
    expect(executeTool).not.toHaveBeenCalled()
    expect(turn).toBe(1)
  }, 60_000)
})

describe('instructions in sub-folders', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-nested-loop-${process.pid}-${Date.now()}`)
    mkdirSync(join(workspace, 'packages', 'api'), { recursive: true })
    writeFileSync(join(workspace, 'packages', 'api', 'AGENTS.md'), 'API package: every handler validates with zod.', 'utf8')
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    executeTool.mockResolvedValue({ ok: true, summary: 'read', content: 'export function handler() {}' })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('reach the model with the first read under their folder, and only once', async () => {
    const seen: string[] = []
    let turn = 0
    streamChat.mockImplementation(async function* (req: { messages: unknown[] }): AsyncGenerator<StreamChunk> {
      turn += 1
      seen.push(JSON.stringify(req.messages))
      if (turn <= 2) {
        yield { type: 'tool_call', toolCall: { id: `c${turn}`, name: 'read', arguments: JSON.stringify({ path: `packages/api/h${turn}.ts` }) } }
        yield { type: 'done', stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } }
        return
      }
      yield { type: 'text', text: 'Done.' }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }
    })
    for await (const ev of runAgent({ runId: 'nested-rules', messages: [{ role: 'user', content: 'look' }], workspacePath: workspace })) {
      void ev
    }
    expect(turn).toBe(3)
    expect(seen[0]).not.toContain('every handler validates with zod')
    expect(seen[1]).toContain('every handler validates with zod')
    expect(seen[2]!.match(/every handler validates with zod/g)).toHaveLength(1)
  }, 60_000)
})

describe('hooks in a run', () => {
  let workspace: string
  let scripts: string

  function hookScript(name: string, body: string): string {
    const file = join(scripts, `${name}.cjs`)
    writeFileSync(file, body, 'utf8')
    return `node "${file}"`
  }

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-hooks-loop-${process.pid}-${Date.now()}`)
    scripts = join(workspace, '..', `vyotiq-hooks-loop-sh-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(scripts, { recursive: true })
    mkdirSync(userData, { recursive: true })
    resetActiveRunsForTests()
    resetAgentQuestionForTests()
    resetHooksForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    executeTool.mockResolvedValue({ ok: true, summary: 'read', content: 'file body' })
  })

  afterEach(() => {
    rmSync(join(userData, 'hooks.json'), { force: true })
    rmSync(join(userData, 'hook-trust.json'), { force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(scripts)) rmSync(scripts, { recursive: true, force: true })
  })

  /** One read, then an answer each turn after. */
  function readThenAnswer(): { turns: () => number; seen: string[] } {
    const seen: string[] = []
    let turn = 0
    streamChat.mockImplementation(async function* (req: { messages: unknown[] }): AsyncGenerator<StreamChunk> {
      turn += 1
      seen.push(JSON.stringify(req.messages))
      if (turn === 1) {
        yield { type: 'tool_call', toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } }
        yield { type: 'done', stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } }
        return
      }
      yield { type: 'text', text: `Answer ${turn}.` }
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }
    })
    return { turns: () => turn, seen }
  }

  it('a PreToolUse hook blocks the call, and a Stop hook keeps the run going once', async () => {
    const stopMarker = join(scripts, 'stopped-once')
    writeFileSync(
      join(userData, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'read', hooks: [{ type: 'command', command: hookScript('block', "process.stderr.write('reads are off today');process.exit(2)") }] }],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: hookScript(
                    'stop',
                    `const fs=require('fs');const m=${JSON.stringify(stopMarker)};if(fs.existsSync(m))process.exit(0);fs.writeFileSync(m,'1');process.stderr.write('run the tests first');process.exit(2)`
                  )
                }
              ]
            }
          ]
        }
      })
    )
    const run = readThenAnswer()
    for await (const ev of runAgent({ runId: 'hooks-run', messages: [{ role: 'user', content: 'go' }], workspacePath: workspace })) {
      void ev
    }
    expect(executeTool).not.toHaveBeenCalled()
    expect(run.seen[1]).toContain('Blocked by a PreToolUse hook: reads are off today')
    // Answer 2 is stopped by the hook once; answer 3 finishes.
    expect(run.turns()).toBe(3)
    expect(run.seen[2]).toContain('run the tests first')
  }, 60_000)

  it("a workspace's hooks run only after the person allows them", async () => {
    mkdirSync(join(workspace, '.vyotiq'), { recursive: true })
    writeFileSync(
      join(workspace, '.vyotiq', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookScript('ws', "process.stderr.write('repo says no');process.exit(2)") }] }] } })
    )
    const asked: string[] = []
    registerQuestionSender('hooks-allowed', (request) => {
      asked.push(request.questions[0]!.prompt)
      queueMicrotask(() =>
        resolveAgentQuestion({
          requestId: request.requestId,
          runId: 'hooks-allowed',
          answers: [{ questionId: request.questions[0]!.id, values: ['Run them'] }]
        })
      )
    })
    const run = readThenAnswer()
    for await (const ev of runAgent({ runId: 'hooks-allowed', messages: [{ role: 'user', content: 'go' }], workspacePath: workspace })) {
      void ev
    }
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/\.vyotiq\/hooks\.json runs commands around the agent's work:\n• PreToolUse: node /)
    expect(executeTool).not.toHaveBeenCalled()
    expect(run.seen[1]).toContain('repo says no')
  }, 60_000)
})
