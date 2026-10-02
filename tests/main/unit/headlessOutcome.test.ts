import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import {
  buildHeadlessResult,
  classifyHeadlessOutcome,
  createTally,
  exitCodeForStatus,
  overStepBudget,
  tallyEvent,
  usageOf,
  type DoneWhenVerdict,
  type HeadlessStatus
} from '@main/headless/outcome'
import { finalOutput, progressLineForEvent, streamJsonForEvent, textSummaryLine } from '@main/headless/format'

const RUN = 'run-1'
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: RUN, ...e }) as AgentEvent

function runOf(events: Record<string, unknown>[]) {
  const tally = createTally(RUN)
  for (const e of events) tallyEvent(tally, ev(e))
  return tally
}

const check = (verdict: DoneWhenVerdict['verdict'], source: DoneWhenVerdict['source'] = 'brief'): DoneWhenVerdict => ({
  id: 'c1',
  text: 'tests pass',
  source,
  verdict
})

describe('tallyEvent', () => {
  it('keeps the last final answer, files, steps, usage and provider', () => {
    const tally = runOf([
      { type: 'status', status: 'running' },
      { type: 'assistant_message', content: 'Let me look.', toolCalls: [{ id: 't', name: 'read', arguments: '{}' }] },
      {
        type: 'step_usage',
        step: 1,
        provider: 'anthropic',
        model: 'claude-x',
        inputTokens: 1000,
        outputTokens: 50,
        billedCost: 0.01
      },
      { type: 'writes_checkpoint', checkpointId: 'k', files: [{ path: 'a.ts', action: 'created', undoable: true }] },
      { type: 'writes_checkpoint', checkpointId: 'k2', files: [{ path: 'a.ts', action: 'modified', undoable: true }] },
      { type: 'assistant_message', content: 'Done: added a.ts.' },
      { type: 'step_usage', step: 2, inputTokens: 1200, outputTokens: 30, estimatedCost: 0.005 },
      { type: 'aux_usage', site: 'compaction_fork', provider: 'anthropic', model: 'claude-x', outputTokens: 10 },
      { type: 'status', status: 'done' }
    ])
    expect(tally.answer).toBe('Done: added a.ts.')
    expect(tally.terminal).toBe('done')
    expect([...tally.files]).toEqual([['a.ts', 'created']])
    expect(tally.provider).toBe('anthropic')
    expect(usageOf(tally)).toEqual({
      steps: 2,
      inputTokens: 2200,
      outputTokens: 90,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.015,
      costSource: 'partial'
    })
  })

  it('counts a helper instance at its latest restated usage', () => {
    const usage = {
      billedInputTokens: 10,
      billedCachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      steps: 1,
      stepsWithCacheReport: 0,
      billedCost: 0.25,
      billedCostSaved: 0,
      stepsWithCostReport: 1,
      estimatedCost: 0,
      stepsWithEstimate: 0,
      generationMs: 1
    }
    const tally = runOf([
      { type: 'agent_instance_update', parentRunId: RUN, instanceRunId: 'kid', phase: 'started', usage },
      { type: 'agent_instance_update', parentRunId: RUN, instanceRunId: 'kid', phase: 'done', usage: { ...usage, billedCost: 0.5 } }
    ])
    expect(usageOf(tally)).toMatchObject({ costUsd: 0.5, costSource: 'billed', outputTokens: 5 })
  })

  it('remembers an incomplete notice only while nothing follows it', () => {
    const stuck = runOf([{ type: 'incomplete', reason: 'truncated', message: 'Cut off' }])
    expect(stuck.incomplete?.reason).toBe('truncated')
    const recovered = runOf([
      { type: 'incomplete', reason: 'truncated', message: 'Cut off' },
      { type: 'step_usage', step: 2 }
    ])
    expect(recovered.incomplete).toBeUndefined()
  })

  it('ignores another run’s events', () => {
    const tally = createTally(RUN)
    tallyEvent(tally, { type: 'assistant_message', runId: 'child', content: 'not mine' } as AgentEvent)
    expect(tally.answer).toBe('')
  })
})

describe('classifyHeadlessOutcome', () => {
  const base = { checks: [] as DoneWhenVerdict[], deniedApprovals: 0 }

  it('maps the loop’s terminal status', () => {
    expect(classifyHeadlessOutcome({ ...base, terminal: 'done' })).toBe('done')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'error' })).toBe('failed')
    expect(classifyHeadlessOutcome({ ...base })).toBe('failed')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'cancelled' })).toBe('cancelled')
  })

  it('reports the runner’s own stop over anything the loop said', () => {
    expect(classifyHeadlessOutcome({ ...base, terminal: 'cancelled', stopCause: 'timeout' })).toBe('timeout')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'cancelled', stopCause: 'max_cost' })).toBe('max_cost')
  })

  it('holds done to the brief’s checks, not to a plan’s unmarked ones', () => {
    expect(classifyHeadlessOutcome({ ...base, terminal: 'done', checks: [check('met')] })).toBe('done')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'done', checks: [check(null)] })).toBe('not_met')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'done', checks: [check('not_met', 'plan')] })).toBe('not_met')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'done', checks: [check(null, 'plan')] })).toBe('done')
  })

  it('calls a failure with refused approvals blocked', () => {
    expect(classifyHeadlessOutcome({ ...base, terminal: 'error', deniedApprovals: 2 })).toBe('blocked')
    expect(classifyHeadlessOutcome({ ...base, terminal: 'done', deniedApprovals: 2 })).toBe('done')
    expect(
      classifyHeadlessOutcome({ ...base, terminal: 'done', checks: [check('not_met')], deniedApprovals: 1 })
    ).toBe('blocked')
  })

  it('treats a run that stopped on an incomplete notice as incomplete', () => {
    expect(
      classifyHeadlessOutcome({ ...base, terminal: 'done', incomplete: { reason: 'spend_limit', message: 'x' } })
    ).toBe('incomplete')
  })
})

describe('exitCodeForStatus', () => {
  it.each<[HeadlessStatus, number]>([
    ['done', 0],
    ['not_met', 1],
    ['failed', 1],
    ['incomplete', 1],
    ['cancelled', 1],
    ['max_steps', 1],
    ['max_cost', 1],
    ['blocked', 3],
    ['needs_input', 3],
    ['timeout', 124],
    ['interrupted', 130]
  ])('%s → %i', (status, code) => {
    expect(exitCodeForStatus(status)).toBe(code)
  })
})

describe('overStepBudget', () => {
  it('lets the last step finish its tools and stops at the next model call', () => {
    const tally = runOf([{ type: 'step_usage', step: 1 }])
    expect(overStepBudget(tally, 1, ev({ type: 'tool_start', toolCallId: 't', name: 'read', summary: '' }))).toBe(false)
    expect(overStepBudget(tally, 1, ev({ type: 'text_delta', text: 'x' }))).toBe(true)
    expect(overStepBudget(tally, 2, ev({ type: 'text_delta', text: 'x' }))).toBe(false)
    expect(overStepBudget(tally, undefined, ev({ type: 'text_delta', text: 'x' }))).toBe(false)
  })
})

describe('output formats', () => {
  const tally = runOf([
    { type: 'assistant_message', content: 'Two files.' },
    { type: 'step_usage', step: 1, billedCost: 0.02 },
    { type: 'status', status: 'done' }
  ])
  const result = buildHeadlessResult({
    tally,
    status: 'done',
    workspacePath: '/repo',
    mode: 'ask',
    checks: [check('met')],
    approvals: { allowed: 0, denied: 0, deniedCalls: [] },
    questions: 0,
    durationMs: 1234
  })

  it('builds the result object', () => {
    expect(result).toMatchObject({
      type: 'result',
      status: 'done',
      exitCode: 0,
      runId: RUN,
      answer: 'Two files.',
      filesChanged: [],
      doneWhen: [{ id: 'c1', verdict: 'met' }],
      usage: { steps: 1, costUsd: 0.02, costSource: 'billed' }
    })
    expect(result).not.toHaveProperty('error')
  })

  it('text is the answer alone; json is the object; stream-json one line', () => {
    expect(finalOutput('text', result)).toBe('Two files.\n')
    expect(JSON.parse(finalOutput('json', result))).toEqual(result)
    const line = finalOutput('stream-json', result)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trim().includes('\n')).toBe(false)
    expect(JSON.parse(line).type).toBe('result')
  })

  it('summarises on stderr with the checks', () => {
    const summary = textSummaryLine(result)
    expect(summary).toMatch(/^— done · 1 step · \$0\.02 · run run-1/)
    expect(summary).toMatch(/✓ tests pass/)
  })

  it('streams events as one JSON object per line and skips internal ones', () => {
    expect(JSON.parse(streamJsonForEvent(ev({ type: 'text_delta', text: 'hi' }))!)).toEqual({
      runId: RUN,
      type: 'text_delta',
      text: 'hi'
    })
    expect(streamJsonForEvent(ev({ type: 'stream_snapshot', step: 1, text: '' }))).toBeNull()
  })

  it('prints a progress line for tools and failures only', () => {
    expect(progressLineForEvent(ev({ type: 'tool_start', toolCallId: 't', name: 'read', summary: 'src/a.ts' }))).toBe(
      '· read src/a.ts'
    )
    expect(progressLineForEvent(ev({ type: 'text_delta', text: 'x' }))).toBeNull()
    expect(progressLineForEvent(ev({ type: 'error', message: 'No API key' }))).toBe('✗ No API key')
  })
})
