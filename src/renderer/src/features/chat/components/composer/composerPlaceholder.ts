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
  if (opts.running) return line('Queue a follow-up…', attachAndSlash())

  switch (opts.agentMode) {
    case 'ask':
      return line(
        opts.hasTranscript ? 'Ask a follow-up' : 'Ask a question',
        'won’t edit files',
        attachAndSlash()
      )
    case 'plan':
      return line(
        opts.hasTranscript ? 'Refine the plan' : 'Describe a plan',
        attachAndSlash()
      )
    case 'agent':
    default:
      return line(
        opts.hasTranscript ? 'Send a follow-up' : 'Describe a task',
        attachAndSlash()
      )
  }
}
