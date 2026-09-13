import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatMessage } from '@shared/ipc'
import type {
  LlmProvider,
  ProviderChatRequest,
  StreamChunk,
  ToolDefinition
} from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-compact-verify-${process.pid}-${Date.now()}`)

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

import { assembleContext } from '@main/agent/context/assemble'
import { applyFoldedMessagesWatermark } from '@main/agent/context/foldWatermark'
import { loopHintAfterCompaction } from '@main/agent/loopPolicy'
import { createRun, loadCompaction, readContract } from '@main/agent/state'
import {
  CompactionVerifyFailedError,
  executeCompactEvents,
  type CompactPlan
} from '@main/agent/compactRun'

const root = join(tmpdir(), `vyotiq-compact-verify-${process.pid}-${Date.now()}`)
const workspace = join(root, 'ws')

const MODEL = {
  id: 'gpt-4o',
  inputModalities: ['text'] as const,
  outputModalities: ['text'] as const,
  supportsTools: true,
  supportsVision: false,
  contextWindow: 128_000,
  supportsStructuredOutput: false
}

function mockProviderPerCall(handlers: Array<() => StreamChunk[]>): LlmProvider {
  let call = 0
  return {
    id: 'openai',
    async *streamChat() {
      const chunks = handlers[Math.min(call, handlers.length - 1)]()
      call++
      for (const chunk of chunks) yield chunk
    },
    listModels: async () => []
  }
}

function capturingProvider(handlers: Array<() => StreamChunk[]>): {
  provider: LlmProvider
  requests: ProviderChatRequest[]
} {
  const requests: ProviderChatRequest[] = []
  let call = 0
  return {
    requests,
    provider: {
      id: 'openai',
      async *streamChat(req) {
        requests.push(req)
        const chunks = handlers[Math.min(call, handlers.length - 1)]()
        call++
        for (const chunk of chunks) yield chunk
      },
      listModels: async () => []
    }
  }
}

function toolOk(id: string, name: string, content = 'ok'): ChatMessage {
  return { role: 'tool', content, toolCallId: id, toolName: name, ok: true }
}

const FAITHFUL = `## Session Intent
Rewrite auth to JWT

## Files Touched
- src/auth.ts

## Key Decisions
- Use JWT

## Next Steps
- Add tests`

const AMNESIA = `## Session Intent
Did some work

## Files Touched
- (none)

## Key Decisions
- (none)`

const RECORDED_SUMMARY = readFileSync(
  join(__dirname, '../../fixtures/compact/recorded-81cf5721-verify-failed-summary.md'),
  'utf8'
)
  .replace(
    /^(Session Intent|Files Touched|Key Decisions|Constraints|Open Bugs\/Blockers|Next Steps)$/gm,
    '## $1'
  )
  .trim()

const CORE_DECISION =
  'Primary language/runtime for the agent core?: Not sure \u2014 recommend one'
const P5_DECISION =
  'MCP transports to implement in phase P5?: Both stdio and HTTP/SSE transports at P5'

function foldedHistory(): ChatMessage[] {
  return [
    { role: 'user', content: 'fix auth in src/auth.ts' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ path: 'src/auth.ts' }) }]
    },
    toolOk('r1', 'read', 'export const auth = 1'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'e1', name: 'edit', arguments: JSON.stringify({ path: 'src/auth.ts', contents: 'x' }) }
      ]
    },
    toolOk('e1', 'edit'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'q1', name: 'ask_question', arguments: '{}' }]
    },
    {
      role: 'tool',
      content: 'User answered: Use JWT',
      toolCallId: 'q1',
      toolName: 'ask_question',
      ok: true
    }
  ]
}

function recordedPrefixHistory(): ChatMessage[] {
  return [
    { role: 'user', content: 'Design the agent. See `plan.md` and `contract.md`.' },
    {
      role: 'assistant',
      content:
        'Using `@modelcontextprotocol/sdk`, `LLMProvider.chat`, `core/agent`, `core/context`, `core/llm`, `core/mcp`, `core/memory`, `core/plugins`, `core/safety`, `core/tools`.',
      toolCalls: [
        { id: 'e1', name: 'edit', arguments: JSON.stringify({ path: 'plan.md', contents: 'x' }) }
      ]
    },
    toolOk('e1', 'edit'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'e2',
          name: 'edit',
          arguments: JSON.stringify({ path: 'contract.md', contents: 'y' })
        }
      ]
    },
    toolOk('e2', 'edit'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'q1', name: 'ask_question', arguments: '{}' }]
    },
    {
      role: 'tool',
      content: `User answered:\n- ${CORE_DECISION}`,
      toolCallId: 'q1',
      toolName: 'ask_question',
      ok: true
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'q2', name: 'ask_question', arguments: '{}' }]
    },
    {
      role: 'tool',
      content: `User answered:\n- ${P5_DECISION}`,
      toolCallId: 'q2',
      toolName: 'ask_question',
      ok: true
    }
  ]
}

function makePlan(
  runDir: string,
  runId: string,
  provider: LlmProvider,
  toSummarize: ChatMessage[] = foldedHistory()
): CompactPlan {
  const kept: ChatMessage[] = [
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'working' }
  ]
  return {
    runDir,
    runId,
    providerId: 'openai',
    provider,
    model: MODEL,
    apiKey: 'test',
    baseUrl: undefined,
    abort: {
      signal: new AbortController().signal,
      timedOut: () => false,
      userAborted: () => false
    },
    working: [...toSummarize, ...kept],
    kept,
    toSummarize,
    baseFolded: 0,
    existing: null
  }
}

async function drain(
  plan: CompactPlan
): Promise<{ events: { type: string }[]; result: unknown }> {
  const events: { type: string }[] = []
  const gen = executeCompactEvents(plan, undefined, 'manual')
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

describe('executeCompactEvents extractive gate', () => {
  beforeEach(() => {
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('retries once with flattened request when the first summarizer returns an empty response', async () => {
    // Regression: session d8883185 died at step ~200 with
    // "The model returned no summary" after ONE empty summarizer response.
    // The timeout path already retried; the empty-response path must too.
    const runId = 'run-empty-then-ok'
    const dir = createRun(workspace, runId, 'Rewrite auth to JWT')
    // Call 1: empty response (no text chunks) -> retry; Call 2: faithful summary.
    const plan = makePlan(
      dir,
      runId,
      mockProviderPerCall([() => [], () => [{ type: 'text', text: FAITHFUL }]])
    )

    const { events, result } = await drain(plan)
    expect(events.map((e) => e.type)).toEqual([
      'compaction_started',
      'compaction_verifying',
      'compaction'
    ])
    expect(result).toMatchObject({ verified: true })
    expect(String((result as { summary: string }).summary)).toContain('Use JWT')
  })

  it('pins omitted extractive facts so an amnesic summary verifies without retry', async () => {
    const runId = 'run-ok'
    const dir = createRun(workspace, runId, 'Rewrite auth to JWT')
    const plan = makePlan(
      dir,
      runId,
      mockProviderPerCall([() => [{ type: 'text', text: AMNESIA }]])
    )

    const { events, result } = await drain(plan)
    expect(events.map((e) => e.type)).toEqual([
      'compaction_started',
      'compaction_verifying',
      'compaction'
    ])
    expect(result).toMatchObject({ verified: true })
    expect(String((result as { summary: string }).summary)).toContain('src/auth.ts')
    expect(String((result as { summary: string }).summary)).toContain('Use JWT')
    const saved = loadCompaction(dir)
    expect(saved?.verified).toBe(true)
    expect(saved?.foldedMessages).toBe(plan.toSummarize.length)
    expect(saved?.pinnedFacts?.wroteFiles).toContain('src/auth.ts')
    expect(saved?.pinnedFacts?.decisions?.some((d) => d.includes('JWT'))).toBe(true)
  })

  it('does not write compaction.json when an invented path still fails after retry', async () => {
    const invented = `## Session Intent
Rewrite auth to JWT

## Files Touched
- src/auth.ts
- src/invented/nope.ts

## Key Decisions
- Use JWT`
    const runId = 'run-fail'
    const dir = createRun(workspace, runId, 'Rewrite auth to JWT')
    const plan = makePlan(
      dir,
      runId,
      mockProviderPerCall([
        () => [{ type: 'text', text: invented }],
        () => [{ type: 'text', text: invented }]
      ])
    )

    const events: { type: string }[] = []
    await expect(async () => {
      const gen = executeCompactEvents(plan, undefined, 'manual')
      let next = await gen.next()
      while (!next.done) {
        events.push(next.value)
        next = await gen.next()
      }
    }).rejects.toBeInstanceOf(CompactionVerifyFailedError)

    expect(events.map((e) => e.type)).toEqual([
      'compaction_started',
      'compaction_verifying',
      'compaction_verify_retry',
      'compaction_verifying',
      'compaction_verify_failed'
    ])
    expect(loadCompaction(dir)).toBeNull()
  })

  it('persists the recorded 19:05:40Z summary against prefix-shaped fold facts', async () => {
    const runId = 'run-recorded'
    const dir = createRun(workspace, runId, 'chat')
    const plan = makePlan(
      dir,
      runId,
      mockProviderPerCall([() => [{ type: 'text', text: RECORDED_SUMMARY }]]),
      recordedPrefixHistory()
    )

    const { events, result } = await drain(plan)
    expect(events.map((e) => e.type)).toEqual([
      'compaction_started',
      'compaction_verifying',
      'compaction'
    ])
    expect(result).toMatchObject({ verified: true })
    expect(String((result as { summary: string }).summary)).toContain('TypeScript + Node.js')
    const saved = loadCompaction(dir)
    expect(saved?.verified).toBe(true)
    expect(saved?.foldedMessages).toBe(plan.toSummarize.length)
    expect(saved?.retainedDecisions).toEqual(
      expect.arrayContaining([CORE_DECISION, P5_DECISION])
    )
  })

  it('does not treat prior-summary Files Touched as invented paths on a later fold', async () => {
    const runId = 'run-prior-fold'
    const dir = createRun(workspace, runId, 'Rewrite auth to JWT')
    const priorSummary = `## Session Intent
Earlier work

## Files Touched
- src/old/a.ts

## Key Decisions
- (none)`
    const laterSummary = `## Session Intent
Rewrite auth to JWT

## Files Touched
- src/auth.ts

## Key Decisions
- Use JWT

## Next Steps
- Add tests`
    const plan = makePlan(
      dir,
      runId,
      mockProviderPerCall([() => [{ type: 'text', text: laterSummary }]])
    )
    plan.existing = {
      summary: priorSummary,
      createdAt: new Date().toISOString(),
      tokenEstimate: 40,
      foldedMessages: 4,
      verified: true
    }

    const { events, result } = await drain(plan)
    expect(events.map((e) => e.type)).toEqual([
      'compaction_started',
      'compaction_verifying',
      'compaction'
    ])
    expect(result).toMatchObject({ verified: true })
    const saved = loadCompaction(dir)
    expect(saved?.verified).toBe(true)
    expect(saved?.summary).toContain('src/old/a.ts')
    expect(saved?.summary).toContain('src/auth.ts')
    expect(saved?.summary).toContain('---')
  })

  it('round-trip: planted facts survive in Prior session summary or keep-recent, not only the folded prefix', async () => {
    const runId = 'run-roundtrip'
    const dir = createRun(workspace, runId, 'Rewrite auth to JWT')
    const plan = makePlan(
      dir,
      runId,
      mockProviderPerCall([() => [{ type: 'text', text: FAITHFUL }]])
    )

    await drain(plan)
    const saved = loadCompaction(dir)
    expect(saved?.verified).toBe(true)
    expect(saved?.retainedDecisions).toEqual(['Use JWT'])

    const folded = applyFoldedMessagesWatermark(plan.working, saved!.foldedMessages ?? 0)
    expect(folded.messages).toEqual(plan.kept)
    const remainingText = folded.messages
      .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
      .join('\n')
    expect(remainingText).not.toContain('Use JWT')
    expect(remainingText).not.toMatch(/src\/auth\.ts/)

    const hint = loopHintAfterCompaction(saved!.retainedDecisions)
    expect(hint).toMatch(/Use JWT/)
    expect(hint).toMatch(/do not re-ask/i)

    const assembled = await assembleContext({
      harness: 'harness',
      contract: readContract(dir),
      messages: folded.messages,
      workspacePath: null,
      goal: 'Rewrite auth to JWT',
      model: MODEL,
      toolsJsonEstimate: 50,
      priorCompaction: saved,
      loopHint: hint,
      providerId: 'openai',
      provider: plan.provider,
      signal: new AbortController().signal
    })
    expect(assembled.system).toContain('<prior_session>')
    expect(assembled.system).toContain('Use JWT')
    expect(assembled.system).toContain('src/auth.ts')
    expect(assembled.system).toContain('Rewrite auth to JWT')
    expect(assembled.system).toContain('<run_notice>')
    expect(assembled.system).toMatch(/do not re-ask/i)
    expect(assembled.systemStable).toContain('<prior_session>')
    expect(assembled.systemStable).toContain('Use JWT')
    expect(assembled.systemStable).toContain('src/auth.ts')
    expect(assembled.systemVolatile).not.toContain('<prior_session>')
    expect(assembled.systemVolatile).not.toContain('src/auth.ts')
    expect(assembled.systemVolatile).toContain('<run_notice>')
    expect(assembled.messages).toHaveLength(folded.messages.length)
  })

  it('message-shape summary and verify retry both exclude parent harness and tools', async () => {
    const runId = 'run-fork'
    const dir = createRun(workspace, runId, 'Rewrite auth to JWT')
    const parentTools: ToolDefinition[] = [
      { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } },
      { name: 'edit', description: 'Edit', parameters: { type: 'object', properties: {} } }
    ]
    const parentStable = 'PARENT_STABLE_FORK_UNIQUE'
    const { provider, requests } = capturingProvider([
      () => [{ type: 'text', text: AMNESIA }]
    ])
    const plan = makePlan(dir, runId, provider)
    plan.forkPrefix = { systemStable: parentStable, toolDefs: parentTools }

    const { result } = await drain(plan)
    expect(result).toMatchObject({ verified: true })
    expect(requests.length).toBe(1)

    const forkReq = requests[0]!
    expect(forkReq.tools).toEqual([])
    expect(forkReq.systemStable).toBeUndefined()
    expect(forkReq.system).toMatch(/internal session summarizer/i)
    expect(forkReq.system).not.toContain(parentStable)
    expect(forkReq.toolChoice).toBe('none')
    expect(forkReq.messages.slice(0, plan.toSummarize.length)).toEqual(plan.toSummarize)
    const forkLast = forkReq.messages[forkReq.messages.length - 1]!
    expect(forkLast.role).toBe('user')
    expect(String(forkLast.content)).toMatch(/Summarize the preceding session history/)
  })
})
