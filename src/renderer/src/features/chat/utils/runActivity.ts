import { truncateText } from '../toolUi/parsers/common'

export type RunActivityPhase =
  | { kind: 'planning' }
  | { kind: 'working' }
  | { kind: 'reconnecting'; attempt: number; maxAttempts: number; reason?: string }
  | { kind: 'compacting' }
  | { kind: 'verifying_compact' }
  | { kind: 'retrying_compact' }
  | { kind: 'thinking' }
  | { kind: 'writing' }
  | { kind: 'awaiting_approval' }
  | { kind: 'awaiting_question' }
  | { kind: 'tool'; label: string; detail?: string }

/** Match tool-group subtitle truncation so timeline detail agrees with chrome. */
const MAX_DETAIL_CHARS = 80

function truncateDetail(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return truncateText(trimmed, MAX_DETAIL_CHARS)
}

/** The literal phase wording: what announcements say, and what unvoiced phases render. */
export function formatRunActivityLabel(phase: RunActivityPhase): string {
  switch (phase.kind) {
    case 'planning':
      return 'Planning'
    case 'working':
      return 'Working'
    case 'reconnecting': {
      // maxAttempts 0 means "retry until it recovers" — "(17/0)" reads as a bug.
      const count =
        phase.maxAttempts > 0
          ? `${phase.attempt}/${phase.maxAttempts}`
          : `attempt ${phase.attempt}`
      const why = truncateDetail(phase.reason)
      return why ? `Reconnecting (${count}) — ${why}` : `Reconnecting (${count})`
    }
    case 'compacting':
      return 'Compacting…'
    case 'verifying_compact':
      return 'Verifying summary…'
    case 'retrying_compact':
      return 'Retrying summary…'
    case 'thinking':
      return 'Thinking'
    case 'writing':
      return 'Writing'
    case 'awaiting_approval':
      return 'Awaiting approval'
    case 'awaiting_question':
      return 'Awaiting answer'
    case 'tool':
      return phase.detail ? `${phase.label} ${phase.detail}` : phase.label
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}
