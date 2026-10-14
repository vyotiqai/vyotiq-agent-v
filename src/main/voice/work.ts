/**
 * The followed run's work as the voice view shows it (docs/voice-mode.md §25):
 * its steps, its result and what it waits on, under the hand-off that started
 * it. Folded from the run's own events, like `trackProgress`; pure, so it's
 * tested on its own. Never the tools' output: only names and one-line
 * summaries, which the task's record already shows.
 */
import type { AgentEvent, AgentQuestionRequest, ToolApprovalRequest } from '../../shared/ipc'
import {
  VOICE_WORK_MAX_RESULT,
  VOICE_WORK_MAX_STEPS,
  type VoiceWork,
  type VoiceWorkAsk,
  type VoiceWorkStep
} from '../../shared/ipc/schemas/voice'
import { stripSpokenBlock } from '../../shared/spokenSummary'

const MAX_SUMMARY = 200

export type WorkLog = {
  runId: string
  startedAt: number
  endedAt?: number
  outcome?: 'done' | 'error' | 'cancelled'
  stepCount: number
  steps: VoiceWorkStep[]
  /** The latest final answer; a later step (a check sent it back to work) clears it. */
  result?: string
}

export function newWorkLog(runId: string, now: number): WorkLog {
  return { runId, startedAt: now, stepCount: 0, steps: [] }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

function setStep(steps: VoiceWorkStep[], id: string, state: VoiceWorkStep['state']): VoiceWorkStep[] {
  const i = steps.findIndex((s) => s.id === id)
  if (i < 0 || steps[i]!.state === state) return steps
  const next = steps.slice()
  next[i] = { ...steps[i]!, state }
  return next
}

/** Fold one run event into the log. */
export function foldWork(log: WorkLog, ev: AgentEvent, now: number): WorkLog {
  switch (ev.type) {
    case 'status':
      if (ev.status === 'running') {
        // A follow-up turn on a finished run starts its work afresh.
        return log.endedAt === undefined ? log : newWorkLog(log.runId, now)
      }
      return {
        ...log,
        endedAt: now,
        outcome: ev.status === 'error' ? 'error' : ev.status === 'cancelled' ? 'cancelled' : 'done',
        // Anything still running when the run ended didn't finish.
        steps: log.steps.map((s) => (s.state === 'running' ? { ...s, state: ev.status === 'error' ? 'failed' : 'done' } : s))
      }
    case 'tool_start': {
      const step: VoiceWorkStep = {
        id: ev.toolCallId.slice(0, 200),
        tool: ev.name.slice(0, 80),
        summary: oneLine(ev.summary ?? '', MAX_SUMMARY),
        state: 'running'
      }
      const steps = [...log.steps.filter((s) => s.id !== step.id), step].slice(-VOICE_WORK_MAX_STEPS)
      const { result: _result, ...rest } = log
      return { ...rest, stepCount: log.stepCount + 1, steps }
    }
    case 'tool_result':
      return { ...log, steps: setStep(log.steps, ev.toolCallId, ev.ok ? 'done' : 'failed') }
    case 'assistant_message': {
      if (ev.toolCalls && ev.toolCalls.length > 0) return log
      const answer = stripSpokenBlock(ev.content ?? '').trim()
      if (!answer) return log
      return { ...log, result: answer.length <= VOICE_WORK_MAX_RESULT ? answer : `${answer.slice(0, VOICE_WORK_MAX_RESULT - 1)}…` }
    }
    default:
      return log
  }
}

/** What an approval or question asks of the person, as the view offers it. */
export function workAsk(
  approval: ToolApprovalRequest | null,
  question: AgentQuestionRequest | null,
  describeApproval: (req: ToolApprovalRequest) => string,
  /** Whether the card offers its plain Always allow for this one; the view offers the same, never more. */
  mayAlwaysAllow: (req: ToolApprovalRequest) => boolean = () => false
): VoiceWorkAsk | undefined {
  if (approval) {
    return {
      kind: 'approval',
      requestId: approval.requestId,
      what: oneLine(describeApproval(approval), 300),
      risky: Boolean(approval.danger),
      ...(mayAlwaysAllow(approval) ? { always: true } : {})
    }
  }
  if (question) {
    const [first] = question.questions
    if (!first) return undefined
    // One question with one pick or a yes/no: a click can answer it. Anything else is the card's.
    const one = question.questions.length === 1
    const options = !one ? [] : first.type === 'boolean' ? ['Yes', 'No'] : first.type === 'single' ? (first.options ?? []).slice(0, 12) : []
    return {
      kind: 'question',
      requestId: question.requestId,
      questionId: first.id,
      prompt: oneLine(one ? first.prompt : `It has ${question.questions.length} questions for you.`, 1000),
      options: options.map((o) => oneLine(o, 200))
    }
  }
  return undefined
}

/** The log as the event carries it. */
export function workSnapshot(log: WorkLog, ask: VoiceWorkAsk | undefined): VoiceWork {
  const state: VoiceWork['state'] =
    log.endedAt === undefined
      ? ask
        ? 'needs'
        : 'running'
      : log.outcome === 'error'
        ? 'failed'
        : log.outcome === 'cancelled'
          ? 'stopped'
          : 'done'
  return {
    runId: log.runId,
    state,
    startedAt: log.startedAt,
    ...(log.endedAt !== undefined ? { endedAt: log.endedAt } : {}),
    stepCount: log.stepCount,
    steps: log.steps,
    ...(log.result && log.endedAt !== undefined ? { result: log.result } : {}),
    ...(ask && log.endedAt === undefined ? { ask } : {})
  }
}
