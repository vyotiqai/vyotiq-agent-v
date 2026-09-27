import type { AgentInteractionMode } from '@shared/ipc'

/**
 * The instruction line's placeholder says what sending does right now. While
 * a run is live the instruction queues and applies when the run's turn ends
 * (the loop drains queued follow-ups at turn end); after that it starts the
 * task's next run. Ask mode keeps its one fact: it won't edit files.
 */
export function resolveLinePlaceholder(opts: {
  hasWorkspace: boolean
  running: boolean
  agentMode: AgentInteractionMode
  /** Runs the task has had so far. */
  runCount: number
}): string {
  if (!opts.hasWorkspace) return 'Open a workspace to start a task'
  if (opts.running) return 'Add an instruction — starts when this run ends · Shift+Enter sends it now'
  const readOnly = opts.agentMode === 'ask' ? ' · won’t edit files' : ''
  if (opts.runCount > 0) return `Follow up — starts run ${opts.runCount + 1}${readOnly}`
  return `Add an instruction${readOnly}`
}
