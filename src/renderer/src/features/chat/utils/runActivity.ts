import { getToolHeaderMeta } from '../toolUi'
import { truncateText } from '../toolUi/parsers/common'
import { runVoicePhrase } from './runVoice'
import { mapToolGroupProps } from './toolGroupAdapter'
import type { TranscriptRow } from './transcriptRows'

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

function toolPhaseFromCard(row: Extract<TranscriptRow, { kind: 'card' }>): RunActivityPhase {
  const meta = getToolHeaderMeta(row.item.tool, {
    toolProgress: row.item.toolProgress
  })
  return {
    kind: 'tool',
    label: meta.verb,
    detail: truncateDetail(meta.target)
  }
}

function toolPhaseFromActivity(row: Extract<TranscriptRow, { kind: 'activity' }>): RunActivityPhase {
  const uiTools = row.tools.map((item) => item.tool)
  const props = mapToolGroupProps(uiTools, {})
  const runningTools = row.tools.filter((item) => item.tool.status === 'running')

  if (props.singleTool && runningTools[0]) {
    const runningTool = runningTools[0]
    const meta = getToolHeaderMeta(runningTool.tool, {
      toolProgress: runningTool.toolProgress
    })
    return {
      kind: 'tool',
      label: props.runningLabel,
      detail: truncateDetail(meta.target)
    }
  }

  return {
    kind: 'tool',
    label: props.runningLabel,
    detail: truncateDetail(props.summary)
  }
}

/**
 * Live turn-summary label, in the transcript's voice. Always use the specific
 * phase so collapsed and expanded chrome stay aligned; announcements keep the
 * literal `formatRunActivityLabel` so a rotating phrase never re-announces.
 */
export function turnSummaryVoiceLabel(
  activity: RunActivityPhase | null | undefined,
  tick: number
): string {
  return activity ? runActivityVoiceLabel(activity, tick) : runVoicePhrase('working', tick)
}

/**
 * What the timeline shows. Same phase and same detail as the literal label,
 * except that the four phases with no verb of their own speak in the
 * transcript's voice. Gates, failures, and compaction stay literal: a clever
 * word there would hide what the user has to answer or what went wrong.
 */
export function runActivityVoiceLabel(phase: RunActivityPhase, tick: number): string {
  switch (phase.kind) {
    case 'working':
    case 'thinking':
    case 'planning':
    case 'writing':
      return runVoicePhrase(phase.kind, tick)
    default:
      return formatRunActivityLabel(phase)
  }
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

function lastActiveRow(
  turnRows: TranscriptRow[],
  matches: (row: TranscriptRow) => boolean
): TranscriptRow | undefined {
  for (let index = turnRows.length - 1; index >= 0; index -= 1) {
    const row = turnRows[index]!
    if (matches(row)) return row
  }
  return undefined
}

/**
 * Derive what the agent is doing right now within an active turn.
 * Priority: approval/question → prominent tool → compact tools → planning
 * (running todo_write, detected before coalesce) → writing → thinking → working.
 * Gates beat running parents so nested Allow/Deny / Submit match the timeline label.
 * Within each tier, prefer the latest row so live work beats earlier steps.
 */
export function deriveRunActivity(
  turnRows: TranscriptRow[],
  pendingRun?: boolean,
  opts?: { hiddenThinkingStreaming?: boolean; todoWriteRunning?: boolean }
): RunActivityPhase {
  // Both gates may be pending at once (e.g. a parent question plus a nested
  // approval) — surface the most recent one so the label matches what the
  // user is being asked right now.
  const pendingApproval = lastActiveRow(turnRows, (row) => row.kind === 'approval')
  const pendingQuestion = lastActiveRow(turnRows, (row) => row.kind === 'question')
  if (pendingApproval && pendingQuestion) {
    const approvalIndex = turnRows.lastIndexOf(pendingApproval)
    const questionIndex = turnRows.lastIndexOf(pendingQuestion)
    return questionIndex >= approvalIndex
      ? { kind: 'awaiting_question' }
      : { kind: 'awaiting_approval' }
  }
  if (pendingApproval) return { kind: 'awaiting_approval' }
  if (pendingQuestion) return { kind: 'awaiting_question' }

  const runningCard = lastActiveRow(
    turnRows,
    (row) => row.kind === 'card' && row.item.tool.status === 'running'
  )
  if (runningCard?.kind === 'card') return toolPhaseFromCard(runningCard)

  const runningActivity = lastActiveRow(
    turnRows,
    (row) => row.kind === 'activity' && row.tools.some((item) => item.tool.status === 'running')
  )
  if (runningActivity?.kind === 'activity') return toolPhaseFromActivity(runningActivity)

  // Coalesce strips successful/running todo_write rows; this flag is the
  // pre-coalesce substitute so Planning still tracks a live todo_write.
  if (opts?.todoWriteRunning) return { kind: 'planning' }

  const streamingText = lastActiveRow(
    turnRows,
    (row) => row.kind === 'text' && row.item.streaming === true
  )
  if (streamingText) return { kind: 'writing' }

  const streamingThinking = lastActiveRow(
    turnRows,
    (row) => row.kind === 'thinking' && row.item.thinkingStreaming === true
  )
  if (streamingThinking || opts?.hiddenThinkingStreaming) return { kind: 'thinking' }

  if (pendingRun) {
    // Empty live turn uses Working, same as between-steps. Planning is only
    // while todo_write is actually running (opts.todoWriteRunning).
    return { kind: 'working' }
  }

  return { kind: 'working' }
}

/** Turn-summary phase while a fold is in flight, derived from the live compact card. */
export function compactActivityFromRows(turnRows: TranscriptRow[]): RunActivityPhase {
  for (let i = turnRows.length - 1; i >= 0; i--) {
    const row = turnRows[i]!
    if (row.kind !== 'compaction') continue
    if (row.verifyStatus === 'verifying') return { kind: 'verifying_compact' }
    if (row.verifyStatus === 'retrying') return { kind: 'retrying_compact' }
  }
  return { kind: 'compacting' }
}
