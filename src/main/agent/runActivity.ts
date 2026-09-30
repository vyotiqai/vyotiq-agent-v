import type { AgentEvent } from '../../shared/ipc'
import { TOOL_LABELS } from '../../shared/utils/toolSummary'

/**
 * What each live run is doing right now, in one line — the navigator's
 * "Running pnpm test" under a running task, and an instance's progress line.
 *
 * Every event a run yields passes through startAgentRun's stream loop, which
 * feeds it here; the live-run list reads it back. Kept free of disk and of the
 * run registry so both sides can import it.
 */
const ACTIVITY_MAX_CHARS = 200

type Activity = { step?: number; line: string }

const activity = new Map<string, Activity>()

/** "Editing src/login.ts", clipped to one line. */
export function activityOf(name: string, summary: string): string {
  const verb = TOOL_LABELS[name]?.running ?? name
  const line = `${verb} ${summary.replace(/\s+/g, ' ').trim()}`.trim()
  return line.length <= ACTIVITY_MAX_CHARS ? line : `${line.slice(0, ACTIVITY_MAX_CHARS - 1)}…`
}

/** A new step is thinking until it calls a tool; a tool names itself. Other events leave the line alone. */
export function noteRunActivity(runId: string, ev: AgentEvent): void {
  if (ev.type === 'context_usage') {
    const prior = activity.get(runId)
    if (prior?.step === ev.step) return
    activity.set(runId, { step: ev.step, line: 'Thinking' })
  } else if (ev.type === 'tool_start') {
    activity.set(runId, { step: activity.get(runId)?.step, line: activityOf(ev.name, ev.summary) })
  }
}

export function runActivityOf(runId: string): string | undefined {
  return activity.get(runId)?.line
}

export function clearRunActivity(runId: string): void {
  activity.delete(runId)
}

export function resetRunActivityForTests(): void {
  activity.clear()
}
