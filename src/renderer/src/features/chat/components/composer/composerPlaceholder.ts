import type { AgentInteractionMode } from '@shared/ipc'

/** Secondary clauses join with middle dot — matches composer chrome elsewhere. */
const SEP = ' · '
const ATTACH = '@ to attach'
const SLASH = '/ for commands'

function line(...parts: string[]): string {
  return parts.filter(Boolean).join(SEP)
}

function attachAndSlash(): string {
  return line(ATTACH, SLASH)
}

/**
 * Mode- and state-aware composer placeholder.
 * Copy stays factual: workspace gate, Ask/Plan/Agent policy, follow-ups, @ attach, slash.
 * The @ and / hints teach the first message only; once a chat has a transcript
 * the placeholder is just the action, so it never runs out of room and gets
 * cut off in a narrow pane.
 */
export function resolveComposerPlaceholder(opts: {
  hasWorkspace: boolean
  running: boolean
  agentMode: AgentInteractionMode
  hasTranscript: boolean
  override?: string
}): string {
  const override = opts.override?.trim()
  if (override) return override
  if (!opts.hasWorkspace) return 'Open a workspace to start chatting'
  if (opts.running) return 'Queue a follow-up…'

  switch (opts.agentMode) {
    case 'ask':
      return opts.hasTranscript
        ? line('Ask a follow-up', 'won’t edit files')
        : line('Ask a question', 'won’t edit files', attachAndSlash())
    case 'plan':
      return opts.hasTranscript ? 'Refine the plan' : line('Describe a plan', attachAndSlash())
    case 'agent':
    default:
      return opts.hasTranscript ? 'Send a follow-up' : line('Describe a task', attachAndSlash())
  }
}

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
  if (!opts.hasWorkspace) return 'Open a workspace to start chatting'
  if (opts.running) return 'Add an instruction — starts when this run ends · Shift+Enter sends it now'
  const readOnly = opts.agentMode === 'ask' ? ' · won’t edit files' : ''
  if (opts.runCount > 0) return `Follow up — starts run ${opts.runCount + 1}${readOnly}`
  return `Add an instruction${readOnly}`
}
