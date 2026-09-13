import type { AgentInteractionMode, RunGoal, RunGoalStatus } from './ipc'
import { LOOP_INTERVAL_MIN_MS, LOOP_INTERVAL_MAX_MS } from './ipc'

export const GOAL_CONTINUE_PREFIX = '[Goal continue]' as const
export { LOOP_INTERVAL_MIN_MS, LOOP_INTERVAL_MAX_MS }

const GOAL_HEADER = '[Goal]'
const LOOP_STOP_RE = /^stop\b/i
const LOOP_INTERVAL_RE = /^(\d+)\s*(s|m|h|d)\b/i

export function isGenericRunTitle(goal: string | undefined | null): boolean {
  const trimmed = (goal ?? '').trim()
  return trimmed.length === 0 || trimmed.toLowerCase() === 'chat'
}

export function formatGoalInvocation(objective: string): string {
  const text = objective.trim()
  return [
    GOAL_HEADER,
    text,
    '',
    'Call `create_goal` with this objective now, then work until `update_goal` with status "complete" or the user pauses. Never pause yourself. Do not stop while required work remains.'
  ].join('\n')
}

export function isGoalContinueMessage(text: string): boolean {
  return text.trimStart().startsWith(GOAL_CONTINUE_PREFIX)
}

export function parseGoalInvocation(text: string): { objective: string } | null {
  const trimmed = text.trim()
  // `[Goal continue]` also starts with `[Goal]`; require the header line exactly.
  if (isGoalContinueMessage(trimmed)) return null
  const nl = trimmed.indexOf('\n')
  const firstLine = (nl < 0 ? trimmed : trimmed.slice(0, nl)).trimEnd()
  if (firstLine !== GOAL_HEADER) return null
  if (nl < 0) return null
  const objective = trimmed.slice(nl + 1).split(/\n/, 1)[0]?.trim() ?? ''
  if (!objective) return null
  return { objective }
}

export function formatGoalContinueMessage(objective: string): string {
  return `${GOAL_CONTINUE_PREFIX} Continue the active goal until it is complete. Objective: ${objective.trim()}`
}

export type LoopCommand =
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'usage' }
  | { kind: 'arm'; intervalMs: number; prompt: string }
  | { kind: 'error'; message: string }

export function loopIntervalMs(amount: number, unit: string): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const factor =
    unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 0
  if (!factor) return null
  return Math.round(amount * factor)
}

export function parseLoopCommand(trailing: string): LoopCommand {
  const text = trailing.trim()
  if (!text) return { kind: 'status' }
  if (LOOP_STOP_RE.test(text)) return { kind: 'stop' }
  const match = LOOP_INTERVAL_RE.exec(text)
  if (!match) {
    return {
      kind: 'usage',
    }
  }
  const amount = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  const intervalMs = loopIntervalMs(amount, unit)
  if (intervalMs == null) {
    return { kind: 'error', message: 'Loop interval must be a positive number with s, m, h, or d.' }
  }
  if (intervalMs < LOOP_INTERVAL_MIN_MS) {
    return { kind: 'error', message: 'Loop interval must be at least 30s.' }
  }
  if (intervalMs > LOOP_INTERVAL_MAX_MS) {
    return { kind: 'error', message: 'Loop interval must be at most 24h.' }
  }
  const prompt = text.slice(match[0].length).trim()
  if (!prompt) {
    return { kind: 'error', message: 'Usage: /loop [interval] <prompt> — example /loop 30s check CI.' }
  }
  return { kind: 'arm', intervalMs, prompt }
}

export function loopUsageMessage(): string {
  return 'Usage: /loop [interval] <prompt> — intervals: 30s, 5m, 2h, 1d (min 30s, max 24h). /loop stop disarms. /loop shows the current timer.'
}

export function formatLoopInterval(intervalMs: number): string {
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`
  return `${Math.round(intervalMs / 1000)}s`
}

export function formatLoopStatusLine(loop: {
  prompt: string
  intervalMs: number
  status: string
  nextAt: string
} | null): string {
  if (!loop) return 'No loop is armed on this chat.'
  if (loop.status !== 'armed') return 'Loop is stopped.'
  return `Loop armed every ${formatLoopInterval(loop.intervalMs)}: ${loop.prompt} (next ${loop.nextAt})`
}

export type GoalAutoContinueDecision = 'continue' | 'stop_wait' | 'none'

export function shouldAutoContinueActiveGoal(input: {
  goalStatus: RunGoalStatus | null | undefined
  agentMode: AgentInteractionMode
  incomplete: boolean
  consecutiveNoToolFinishes: number
}): GoalAutoContinueDecision {
  if (input.goalStatus !== 'active') return 'none'
  // Ask mode is read-only Q&A — auto-looping a goal there would churn Q&A
  // turns without progress. Agent and Plan both work with tools, so both
  // continue an active goal (bounded by the two-finish stop_wait cap).
  if (input.agentMode === 'ask') return 'none'
  if (input.incomplete) return 'none'
  if (input.consecutiveNoToolFinishes >= 2) return 'stop_wait'
  return 'continue'
}

export function serializeGoalContent(goal: RunGoal): string {
  return `Goal ${goal.status}: ${goal.objective}`
}

export function truncateGoalObjective(objective: string, max = 80): string {
  const text = objective.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}
