import type { AgentInteractionMode } from '@shared/ipc'

/** How the task's latest run ended, when that changes what the line is for. */
export type LineOutcome = 'failed' | 'stopped' | null

/**
 * The instruction line's placeholder follows the task: while a run is live
 * an instruction steers it (Send now) or queues for when its turn ends; after
 * a failure or a stop it is what to do differently; otherwise a change or a
 * follow-up. Ask mode keeps its one fact: it reads, and changes nothing.
 */
export function resolveLinePlaceholder(opts: {
  hasWorkspace: boolean
  running: boolean
  agentMode: AgentInteractionMode
  outcome?: LineOutcome
}): string {
  if (!opts.hasWorkspace) return 'Open a workspace to start a task'
  if (opts.running) return 'Steer it, or queue what comes next…'
  if (opts.agentMode === 'ask') return 'Ask about the code — it reads, and changes nothing'
  if (opts.outcome === 'failed') return 'Tell it what to do differently…'
  if (opts.outcome === 'stopped') return 'Say what to change before it carries on…'
  return 'Ask for a change, or a follow-up…'
}
