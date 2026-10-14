import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentQuestionRequest, ToolApprovalRequest } from '../../../src/shared/ipc'
import { VOICE_WORK_MAX_STEPS, VoiceWorkSchema } from '../../../src/shared/ipc/schemas/voice'
import { describeApproval, voiceMayAlwaysAllow } from '../../../src/main/voice/session'
import { foldWork, newWorkLog, workAsk, workSnapshot, type WorkLog } from '../../../src/main/voice/work'

/** Run events as the tap sees them; only the fields the fold reads. */
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'r1', ...e }) as unknown as AgentEvent

function fold(events: AgentEvent[], start = newWorkLog('r1', 1000)): WorkLog {
  return events.reduce((log, e, i) => foldWork(log, e, 2000 + i * 1000), start)
}

describe('the voice view’s work (§25)', () => {
  it('lists each step with its state, and how the run ended', () => {
    const log = fold([
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'tool_start', toolCallId: 'a', name: 'read', summary: 'package.json' }),
      ev({ type: 'tool_result', toolCallId: 'a', name: 'read', summary: '', ok: true }),
      ev({ type: 'tool_start', toolCallId: 'b', name: 'terminal', summary: 'pnpm   test\n --run' }),
      ev({ type: 'tool_result', toolCallId: 'b', name: 'terminal', summary: '', ok: false }),
      ev({ type: 'assistant_message', content: '<spoken>All done.</spoken>\nThe test **passes** now.' }),
      ev({ type: 'status', status: 'done' })
    ])
    const work = workSnapshot(log, undefined)
    expect(work).toEqual({
      runId: 'r1',
      state: 'done',
      startedAt: 1000,
      endedAt: 8000,
      stepCount: 2,
      steps: [
        { id: 'a', tool: 'read', summary: 'package.json', state: 'done' },
        { id: 'b', tool: 'terminal', summary: 'pnpm test --run', state: 'failed' }
      ],
      // The written answer, not the spoken block the voice already said.
      result: 'The test **passes** now.'
    })
    expect(VoiceWorkSchema.safeParse(work).success).toBe(true)
  })

  it('shows no result while it works, and drops one a later step overtook (a check sent it back)', () => {
    let log = fold([
      ev({ type: 'tool_start', toolCallId: 'a', name: 'read', summary: 'x' }),
      ev({ type: 'assistant_message', content: 'Looks fixed.' })
    ])
    expect(workSnapshot(log, undefined)).toMatchObject({ state: 'running' })
    expect(workSnapshot(log, undefined).result).toBeUndefined()
    log = foldWork(log, ev({ type: 'tool_start', toolCallId: 'b', name: 'terminal', summary: 'pnpm lint' }), 9000)
    log = foldWork(log, ev({ type: 'status', status: 'done' }), 9500)
    expect(workSnapshot(log, undefined).result).toBeUndefined()
  })

  it('a run the verification gate sent back ends on its answer written again, as the record reads it', () => {
    const log = fold([
      ev({ type: 'status', status: 'running' }),
      ev({ type: 'tool_start', toolCallId: 'a', name: 'edit', summary: 'settings.ts' }),
      ev({ type: 'tool_result', toolCallId: 'a', name: 'edit', summary: '', ok: true }),
      ev({ type: 'assistant_message', content: '<spoken>Renamed it.</spoken>\nRenamed `voice` to `speech`.' }),
      // The gate's nudge is a synthetic message, not an event: the next thing is the check.
      ev({ type: 'tool_start', toolCallId: 'b', name: 'run_tests', summary: 'settings' }),
      ev({ type: 'tool_result', toolCallId: 'b', name: 'run_tests', summary: '', ok: true }),
      ev({ type: 'assistant_message', content: '<spoken>Renamed it; tests pass.</spoken>\nRenamed `voice` to `speech`. The settings tests pass.' }),
      ev({ type: 'status', status: 'done' })
    ])
    expect(workSnapshot(log, undefined)).toMatchObject({
      state: 'done',
      stepCount: 2,
      result: 'Renamed `voice` to `speech`. The settings tests pass.'
    })
  })

  it('a step still running when the run is stopped is not left spinning', () => {
    const log = fold([
      ev({ type: 'tool_start', toolCallId: 'a', name: 'terminal', summary: 'sleep 100' }),
      ev({ type: 'status', status: 'cancelled' })
    ])
    expect(workSnapshot(log, undefined)).toMatchObject({ state: 'stopped', steps: [{ state: 'done' }] })
  })

  it('a follow-up turn on a finished run starts its work afresh', () => {
    const done = fold([ev({ type: 'tool_start', toolCallId: 'a', name: 'read', summary: 'x' }), ev({ type: 'status', status: 'done' })])
    const again = foldWork(done, ev({ type: 'status', status: 'running' }), 50_000)
    expect(workSnapshot(again, undefined)).toEqual({ runId: 'r1', state: 'running', startedAt: 50_000, stepCount: 0, steps: [] })
  })

  it(`lists the newest ${VOICE_WORK_MAX_STEPS} steps and counts every one`, () => {
    const events = Array.from({ length: VOICE_WORK_MAX_STEPS + 5 }, (_, i) => ev({ type: 'tool_start', toolCallId: `t${i}`, name: 'read', summary: `f${i}` }))
    const work = workSnapshot(fold(events), undefined)
    expect(work.steps).toHaveLength(VOICE_WORK_MAX_STEPS)
    expect(work.stepCount).toBe(VOICE_WORK_MAX_STEPS + 5)
    expect(work.steps[0]!.summary).toBe('f5')
  })

  it('waits on an approval: what it wants, and whether only the card may answer', () => {
    const approval = { requestId: 'q1', runId: 'r1', name: 'terminal', summary: 'git stash' } as ToolApprovalRequest
    const ask = workAsk(approval, null, describeApproval)
    expect(ask).toEqual({ kind: 'approval', requestId: 'q1', what: 'run git stash', risky: false })
    expect(workAsk({ ...approval, danger: 'deletes files' }, null, describeApproval)).toMatchObject({ risky: true })
    expect(workSnapshot(newWorkLog('r1', 0), ask)).toMatchObject({ state: 'needs', ask })
  })

  it('offers Always allow exactly where the card does: never risky, never an unscoped command', () => {
    const approval = { requestId: 'q1', runId: 'r1', name: 'terminal', summary: 'pnpm test', alwaysAllowCommand: 'pnpm test' } as ToolApprovalRequest
    expect(workAsk(approval, null, describeApproval, voiceMayAlwaysAllow)).toMatchObject({ always: true })
    expect(workAsk({ ...approval, alwaysAllowCommand: undefined }, null, describeApproval, voiceMayAlwaysAllow)).not.toHaveProperty('always')
    expect(workAsk({ ...approval, danger: 'deletes files' }, null, describeApproval, voiceMayAlwaysAllow)).not.toHaveProperty('always')
    expect(workAsk({ ...approval, name: 'edit' }, null, describeApproval, voiceMayAlwaysAllow)).toMatchObject({ always: true })
  })

  it('offers a question’s picks only when one click can answer it', () => {
    const q = (questions: AgentQuestionRequest['questions']) =>
      workAsk(null, { requestId: 'q2', runId: 'r1', toolCallId: 'c', questions } as AgentQuestionRequest, describeApproval)
    expect(q([{ id: 'b', prompt: 'Which branch?', type: 'single', options: ['main', 'dev'] }])).toEqual({
      kind: 'question',
      requestId: 'q2',
      questionId: 'b',
      prompt: 'Which branch?',
      options: ['main', 'dev']
    })
    expect(q([{ id: 'y', prompt: 'Push it?', type: 'boolean' }])).toMatchObject({ options: ['Yes', 'No'] })
    expect(q([{ id: 't', prompt: 'Name it', type: 'text' }])).toMatchObject({ options: [] })
    expect(
      q([
        { id: 'a', prompt: 'One?', type: 'boolean' },
        { id: 'b', prompt: 'Two?', type: 'boolean' }
      ])
    ).toMatchObject({ prompt: 'It has 2 questions for you.', options: [] })
  })
})
