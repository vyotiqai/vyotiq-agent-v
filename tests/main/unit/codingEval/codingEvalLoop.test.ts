/**
 * Deterministic end-to-end self-test of the coding eval: the REAL agent loop
 * (runAgent) with REAL tools edits a fresh copy of a fixture repo, the REAL
 * checker scores it, and the runner writes a report — with a scripted
 * provider standing in for the model, so no network and no cost.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

const repoRoot = resolve(__dirname, '../../../..')
const userData = mkdtempSync(join(tmpdir(), 'vyotiq-codingeval-ud-'))
const scratchParent = mkdtempSync(join(tmpdir(), 'vyotiq-codingeval-scratch-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => repoRoot,
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
    model: 'scripted',
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

const { streamChat } = vi.hoisted(() => ({ streamChat: vi.fn() }))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'ollama', listModels: async () => [], streamChat }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'scripted',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

import { createLoopSolver } from '@main/agent/codingEval/loopSolver'
import { runCodingEval } from '@main/agent/codingEval/runner'
import { loadCodingTasks } from '@main/agent/codingEval/tasks'
import { compareReports, writeCodingEvalReport } from '@main/agent/codingEval/report'
import type { CodingEvalReport } from '@main/agent/codingEval/types'

const TASKS_ROOT = join(repoRoot, 'scripts', 'evals', 'coding')

type Turn = { tool: string; args: Record<string, unknown> } | { text: string }

/**
 * A provider that plays back a fixed list of turns, one per model call; once
 * the script runs out (a verification nudge, say) it answers `fallback`.
 */
function scriptedProvider(turns: Turn[], fallback = 'Done.'): { requests: ProviderChatRequest[] } {
  const queue = [...turns]
  const requests: ProviderChatRequest[] = []
  let n = 0
  streamChat.mockImplementation(async function* (req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    requests.push(req)
    const turn = queue.shift() ?? { text: fallback }
    n += 1
    if ('tool' in turn) {
      yield { type: 'tool_call', toolCall: { id: `call-${n}`, name: turn.tool, arguments: JSON.stringify(turn.args) } }
      yield { type: 'done', stopReason: 'tool_calls', usage: { inputTokens: 1000, outputTokens: 50 } }
      return
    }
    yield { type: 'text', text: turn.text }
    yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 1200, outputTokens: 80 } }
  })
  return { requests }
}

const FIX_PAGINATE: Turn[] = [
  { tool: 'read', args: { path: 'src/paginate.js' } },
  {
    tool: 'str_replace',
    args: { path: 'src/paginate.js', old_string: 'start + size - 1', new_string: 'start + size' }
  },
  {
    tool: 'str_replace',
    args: {
      path: 'src/paginate.js',
      old_string: 'Math.floor(items.length / size)',
      new_string: 'Math.ceil(items.length / size)'
    }
  },
  { text: 'Fixed the slice end and rounded the page count up.' }
]

const ASK_PORT: Turn[] = [
  { tool: 'read', args: { path: 'src/server.js' } },
  { tool: 'read', args: { path: 'src/config/defaults.js' } },
  { text: 'It listens on 8443 by default (8000 + the https offset 443); set VY_LISTEN_PORT to override it.' }
]

describe('coding eval end to end (real loop, scripted provider)', () => {
  beforeEach(() => {
    streamChat.mockReset()
  })

  afterAll(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(scratchParent, { recursive: true, force: true })
  })

  it('solves fix-paginate through real tools and the checker passes it', async () => {
    const { requests } = scriptedProvider(FIX_PAGINATE)
    const outDir = join(scratchParent, 'out-fix')
    const tasks = loadCodingTasks(TASKS_ROOT, 'fix-paginate')
    expect(tasks.map((t) => t.id)).toEqual(['fix-paginate'])

    const report = await runCodingEval({
      tasks,
      solver: createLoopSolver({ approve: 'safe' }),
      outDir,
      keep: 'never',
      provider: 'ollama',
      model: 'scripted',
      scratchParent
    })

    const attempt = report.attempts[0]
    expect(attempt.failureReason).toBeUndefined()
    expect(attempt.pass).toBe(true)
    expect(attempt.status).toBe('done')
    expect(attempt.checks.every((c) => c.ok)).toBe(true)
    expect(attempt.steps).toBeGreaterThanOrEqual(4)
    expect(attempt.toolCalls).toBe(3)
    expect(attempt.failedToolCalls).toBe(0)
    expect(attempt.inputTokens).toBeGreaterThan(0)
    // The instruction reached the model as the user's message.
    expect(JSON.stringify(requests[0].messages)).toContain('src/paginate.js')
    // Run artifacts were copied for hand-replay.
    expect(existsSync(join(outDir, 'attempts', 'fix-paginate-1', 'run', 'events.jsonl'))).toBe(true)
    expect(report.totals.passRate).toBe(1)
  }, 120_000)

  it('scores an Ask-mode answer and leaves the workspace untouched', async () => {
    scriptedProvider(ASK_PORT)
    const report = await runCodingEval({
      tasks: loadCodingTasks(TASKS_ROOT, 'ask-server-port'),
      solver: createLoopSolver(),
      outDir: join(scratchParent, 'out-ask'),
      provider: 'ollama',
      model: 'scripted',
      scratchParent
    })
    const attempt = report.attempts[0]
    expect(attempt.failureReason).toBeUndefined()
    expect(attempt.pass).toBe(true)
    expect(readFileSync(join(scratchParent, 'out-ask', 'attempts', 'ask-server-port-1', 'answer.md'), 'utf8')).toContain('8443')
  }, 120_000)

  it('fails an unsolved task with the checker reason, and enforces the step cap', async () => {
    // Reads forever: the step cap must stop it.
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'tool_call', toolCall: { id: `c-${Math.random()}`, name: 'read', arguments: '{"path":"src/paginate.js"}' } }
      yield { type: 'done', stopReason: 'tool_calls', usage: { inputTokens: 500, outputTokens: 10 } }
    })
    const outDir = join(scratchParent, 'out-capped')
    const report = await runCodingEval({
      tasks: loadCodingTasks(TASKS_ROOT, 'fix-paginate'),
      solver: createLoopSolver(),
      outDir,
      caps: { maxSteps: 3 },
      keep: 'failed',
      provider: 'ollama',
      model: 'scripted',
      scratchParent
    })
    const attempt = report.attempts[0]
    expect(attempt.pass).toBe(false)
    expect(attempt.capHit).toBe('max_steps')
    expect(attempt.steps).toBeLessThanOrEqual(4)
    expect(attempt.failureReason).toContain('cap hit: max_steps')
    expect(attempt.failureReason).toContain('node --test passes')
    // keep: 'failed' keeps the workspace for inspection, untouched by the run.
    expect(attempt.workspace && existsSync(attempt.workspace)).toBe(true)
    expect(readFileSync(join(attempt.workspace!, 'src', 'paginate.js'), 'utf8')).toContain('start + size - 1')

    const passing = JSON.parse(JSON.stringify(report)) as CodingEvalReport
    passing.tasks[0].passRate = 1
    const cmp = compareReports(passing, report)
    expect(cmp.regressions).toEqual([{ taskId: 'fix-paginate', before: 1, after: 0 }])
    const written = writeCodingEvalReport(outDir, report, cmp)
    expect(readFileSync(written.markdown, 'utf8')).toContain('**Regressions**')
    expect(JSON.parse(readFileSync(written.json, 'utf8')).comparison.regressions).toHaveLength(1)
  }, 120_000)
})
