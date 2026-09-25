import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import type { AgentEvent } from '@shared/ipc'
import { resolveRunDir } from '@main/storage/paths'
import { saveCompaction } from '@main/agent/state'

const userData = join(tmpdir(), `vyotiq-contract-${process.pid}-${Date.now()}`)

const assembleContext = vi.hoisted(() => vi.fn())
const autoCompactLlmEvents = vi.hoisted(() => vi.fn())

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
    assembleContext,
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/compactRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/compactRun')>()
  return { ...actual, autoCompactLlmEvents }
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
import { resetActiveRunsForTests } from '@main/agent/runRegistry'

type AssembleInput = {
  messages: unknown[]
  contract?: string
  plan?: string
  planVerbatim?: boolean
}

// Complete enough that the loop's shallow-plan nudge stays quiet and each
// invoke is exactly the steps under test.
const PLAN = [
  '# Ship it',
  '',
  '## Goal',
  '',
  'Keep the cached prompt prefix stable while the plan changes mid-invoke.',
  '',
  '## Scope',
  '',
  'In: run artifacts in the prompt. Out: provider-side cache routing.',
  '',
  '## Steps',
  '',
  '1. Freeze contract.md and plan.md per invoke in `src/main/agent/loop.ts` and run `pnpm exec vitest run tests/main/unit/agentLoopContract.test.ts` to verify.',
  '2. Record `prefixHash` on step_usage in `src/main/agent/loop.ts` and run `pnpm usage:report` to see cold steps attributed.',
  '',
  '## Done when',
  '',
  '- [ ] `prefixHash` is identical across the steps of one invoke.',
  '',
  '## Risks',
  '',
  'A write in the middle of an invoke reaches the prompt one invoke later.'
].join('\n')

/** Contract and plan each assembleContext call was handed, in call order. */
function artifactsSeen(): Array<{ contract: string; plan: string; planVerbatim: boolean }> {
  return assembleContext.mock.calls.map((call) => {
    const input = call[0] as AssembleInput
    return {
      contract: input.contract ?? '',
      plan: input.plan ?? '',
      planVerbatim: input.planVerbatim === true
    }
  })
}

/** Step 1 calls a tool, step 2 answers — each reporting usage so step_usage is emitted. */
function toolThenAnswer(): () => AsyncGenerator<StreamChunk> {
  let call = 0
  return async function* (): AsyncGenerator<StreamChunk> {
    call += 1
    if (call === 1) {
      yield {
        type: 'tool_call',
        toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
      }
    } else {
      yield { type: 'text', text: 'done' }
    }
    yield { type: 'done', usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 } }
  }
}

/** The tool call rewrites both artifacts, standing in for create_plan. */
function writeArtifactsOnToolCall(runId: string): void {
  executeTool.mockImplementation(async () => {
    const runDir = resolveRunDir(workspace, runId)
    writeFileSync(join(runDir, 'contract.md'), '## Goal\n\nupdated contract\n', 'utf8')
    writeFileSync(join(runDir, 'plan.md'), `${PLAN}\n`, 'utf8')
    return { ok: true, summary: 'file', content: 'body' }
  })
}

type FoldInput = { runId: string; runDir: string }

/** What the real fold yields first; the loop forwards it like any other event. */
function foldStarted(input: FoldInput): AgentEvent {
  return { type: 'compaction_started', runId: input.runId, mode: 'auto' }
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

function prefixHashes(events: AgentEvent[]): Array<string | undefined> {
  return events.flatMap((ev) => (ev.type === 'step_usage' ? [ev.prefixHash] : []))
}

let workspace: string

describe('runAgent run artifacts in the cached prompt prefix', () => {
  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-contract-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    autoCompactLlmEvents.mockReset()
    assembleContext.mockReset()
    // Mirrors the real split: contract and plan render in the stable zone, the
    // part `prefixHash` fingerprints.
    assembleContext.mockImplementation(async (input: AssembleInput) => ({
      messages: input.messages,
      system: `contract:${input.contract ?? ''}`,
      systemStable: `contract:${input.contract ?? ''}\nplan:${input.plan ?? ''}`,
      systemVolatile: '',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      compaction: null
    }))
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('holds contract.md and plan.md for the rest of the invoke, then picks them up on the next', async () => {
    const runId = 'contract-frozen'
    streamChat.mockImplementation(toolThenAnswer())
    writeArtifactsOnToolCall(runId)

    const first = await drain(
      runAgent({ runId, messages: [{ role: 'user', content: 'work' }], workspacePath: workspace })
    )

    // A mid-invoke write must not reach the stable zone: that would void the
    // provider's cache for the whole history on the very next request.
    expect(assembleContext).toHaveBeenCalledTimes(2)
    const [step1, step2] = artifactsSeen()
    expect(step2).toEqual(step1)
    expect(step2!.contract).not.toContain('updated contract')
    expect(step2!.plan).toBe('')
    const firstHashes = prefixHashes(first)
    expect(firstHashes).toHaveLength(2)
    expect(firstHashes[0]).toMatch(/^[0-9a-f]{16}$/)
    expect(firstHashes[1]).toBe(firstHashes[0])

    // The next invoke reads both again, the plan verbatim so str_replace can quote it.
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'ok' }
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 } }
    })
    const second = await drain(
      runAgent({
        runId,
        newMessages: [{ role: 'user', content: 'next' }],
        workspacePath: workspace
      })
    )
    const next = artifactsSeen().at(-1)!
    expect(next.contract).toContain('updated contract')
    expect(next.plan).toBe(PLAN)
    expect(next.planVerbatim).toBe(true)
    expect(prefixHashes(second)[0]).not.toBe(firstHashes[0])

    const contractOnDisk = readFileSync(join(resolveRunDir(workspace, runId), 'contract.md'), 'utf8')
    expect(contractOnDisk).toContain('updated contract')
  })

  it('re-reads them when a compaction fold rewrites the history mid-invoke', async () => {
    const runId = 'contract-fold'
    streamChat.mockImplementation(toolThenAnswer())
    writeArtifactsOnToolCall(runId)
    autoCompactLlmEvents.mockImplementation(async function* (input: FoldInput) {
      yield foldStarted(input)
      saveCompaction(input.runDir, {
        summary: 'Earlier turns, folded.',
        createdAt: new Date().toISOString(),
        tokenEstimate: 10,
        foldedMessages: 0
      })
      return { ok: true, result: { estimatedTokens: 50 } }
    })
    // Step 2's first assemble overflows, which forces the fold.
    let assembles = 0
    const base = assembleContext.getMockImplementation()!
    assembleContext.mockImplementation(async (input: AssembleInput) => {
      assembles += 1
      const result = await base(input)
      return assembles === 2 ? { ...result, overflow: true } : result
    })

    await drain(
      runAgent({ runId, messages: [{ role: 'user', content: 'work' }], workspacePath: workspace })
    )

    expect(autoCompactLlmEvents).toHaveBeenCalledTimes(1)
    const seen = artifactsSeen()
    expect(seen).toHaveLength(3)
    // Before the fold the request still carries what the invoke started with...
    expect(seen[1]!.contract).not.toContain('updated contract')
    expect(seen[1]!.plan).toBe('')
    // ...and the post-fold re-assemble, which misses the cache anyway, catches up.
    expect(seen[2]!.contract).toContain('updated contract')
    expect(seen[2]!.plan).toBe(PLAN)
  })

  it('keeps the caught-up artifacts through the overflow retry fold', async () => {
    const runId = 'contract-fold-retry'
    streamChat.mockImplementation(toolThenAnswer())
    writeArtifactsOnToolCall(runId)
    let folds = 0
    autoCompactLlmEvents.mockImplementation(async function* (input: FoldInput) {
      yield foldStarted(input)
      folds += 1
      saveCompaction(input.runDir, {
        summary: `Earlier turns, fold ${folds}.`,
        createdAt: new Date(Date.UTC(2026, 8, 23, 12, folds)).toISOString(),
        tokenEstimate: 10,
        foldedMessages: 0
      })
      return { ok: true, result: { estimatedTokens: 50 } }
    })
    // Step 2 overflows, and so does the first post-fold re-assemble, which
    // sends the loop down its one overflow retry.
    let assembles = 0
    const base = assembleContext.getMockImplementation()!
    assembleContext.mockImplementation(async (input: AssembleInput) => {
      assembles += 1
      const result = await base(input)
      return assembles === 2 || assembles === 3 ? { ...result, overflow: true } : result
    })

    await drain(
      runAgent({ runId, messages: [{ role: 'user', content: 'work' }], workspacePath: workspace })
    )

    expect(autoCompactLlmEvents).toHaveBeenCalledTimes(2)
    const seen = artifactsSeen()
    expect(seen).toHaveLength(4)
    // The retry re-assemble must not fall back to what the invoke started with.
    expect(seen[3]!.contract).toContain('updated contract')
    expect(seen[3]!.plan).toBe(PLAN)
  })
})
