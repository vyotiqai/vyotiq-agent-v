import type { AgentEvent } from '../../shared/ipc'
import type { HeadlessOutputFormat } from './args'
import type { HeadlessResult } from './outcome'

/**
 * The three output shapes. Pure string builders; the runner decides which
 * stream each goes to:
 *
 * - text: progress lines on stderr, the final answer alone on stdout — so
 *   `answer=$(Vyotiq --headless -p …)` captures just the answer.
 * - json: one object on stdout when the run ends (`HeadlessResult`).
 * - stream-json: one JSON object per line on stdout as things happen — the
 *   run's own events as the app records them, plus `run_started`,
 *   `approval_decision`, `question_answered` and a closing `result` line.
 */

/** Event types too chatty or too internal for a stream-json consumer. */
const STREAM_SKIP: ReadonlySet<AgentEvent['type']> = new Set(['stream_snapshot', 'context_usage'])

export function streamJsonLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`
}

export function streamJsonForEvent(ev: AgentEvent): string | null {
  if (STREAM_SKIP.has(ev.type)) return null
  return streamJsonLine(ev as unknown as Record<string, unknown>)
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One stderr progress line for text mode, or null for events not worth a line. */
export function progressLineForEvent(ev: AgentEvent): string | null {
  switch (ev.type) {
    case 'tool_start':
      return `· ${ev.name}${ev.summary ? ` ${oneLine(ev.summary)}` : ''}`
    case 'tool_result':
      return ev.ok ? null : `  ✗ ${ev.name}: ${oneLine(ev.summary || ev.content || 'failed')}`
    case 'incomplete':
      return `! ${oneLine(ev.message)}`
    case 'error':
      return `✗ ${oneLine(ev.message, 400)}`
    case 'network_wait':
      return `… waiting for the network (attempt ${ev.attempt})${ev.message ? `: ${oneLine(ev.message)}` : ''}`
    case 'model_fallback':
      return `! ${oneLine(ev.message)}`
    case 'compaction':
      return '· compacted earlier context'
    case 'agent_instance_update':
      return ev.phase === 'started'
        ? `· helper started${ev.goal ? `: ${oneLine(ev.goal)}` : ''}`
        : `· helper ${ev.phase}${ev.summary ? `: ${oneLine(ev.summary)}` : ''}`
    default:
      return null
  }
}

function formatUsd(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

/** The closing stderr summary in text mode. */
export function textSummaryLine(result: HeadlessResult): string {
  const parts = [
    result.status,
    `${result.usage.steps} step${result.usage.steps === 1 ? '' : 's'}`,
    ...(result.usage.costSource === 'none' ? [] : [`${formatUsd(result.usage.costUsd)}${result.usage.costSource === 'billed' ? '' : ' est.'}`]),
    ...(result.filesChanged.length ? [`${result.filesChanged.length} file${result.filesChanged.length === 1 ? '' : 's'} changed`] : []),
    ...(result.approvals.denied ? [`${result.approvals.denied} approval${result.approvals.denied === 1 ? '' : 's'} refused`] : []),
    `run ${result.runId}`
  ]
  const lines = [`— ${parts.join(' · ')}`]
  for (const check of result.doneWhen) {
    const mark = check.verdict === 'met' ? '✓' : check.verdict === 'not_met' ? '✗' : '?'
    lines.push(`  ${mark} ${oneLine(check.text)}`)
  }
  if (result.error && result.status !== 'done') lines.push(`  ${oneLine(result.error, 400)}`)
  if (result.worktree) lines.push(`  worktree ${result.worktree.path} (${result.worktree.branch})`)
  return `${lines.join('\n')}\n`
}

/** What goes to stdout (and --output-file) when the run ends. */
export function finalOutput(format: HeadlessOutputFormat, result: HeadlessResult): string {
  switch (format) {
    case 'text':
      return result.answer ? (result.answer.endsWith('\n') ? result.answer : `${result.answer}\n`) : ''
    case 'json':
      return `${JSON.stringify(result, null, 2)}\n`
    case 'stream-json':
      return streamJsonLine(result as unknown as Record<string, unknown>)
    default: {
      const exhaustive: never = format
      return exhaustive
    }
  }
}
