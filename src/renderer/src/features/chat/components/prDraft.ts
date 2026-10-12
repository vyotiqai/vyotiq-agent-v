import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import type { UiItem } from '@shared/transcript'
import { stripGoalMarkdown } from '@shared/utils/taskTitle'
import { buildRecordModel } from '@renderer/features/task/recordModel'

/** What the PR panel writes a draft pull request from: the task's own words. */
export type PrDraftSource = {
  /** The task's title, when it has one. */
  title?: string | null
  /** The run's result: the last thing the agent said once the run ended. */
  summary: string
  checks: readonly DoneWhenCheck[]
  /** Issues the task's brief says it fixes (`Fixes #12`): the PR closes them when it merges. */
  closes?: readonly number[]
}

/**
 * A closing line, on a line of its own: `Fixes #12`, `- Closes: #3.`,
 * `Resolves #7`. Only a whole line counts, so prose that mentions an issue
 * ("this fixes #12 partly") is not taken for a request to close it.
 */
const CLOSING_LINE = /^[ \t]*(?:[-*+][ \t]+)?(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?):?[ \t]+#(\d{1,9})[ \t]*[.,;!]?[ \t]*$/gim

/** A fenced block (``` or ~~~, any length) or a `>` quote: someone else's words, not the person's ask. */
function withoutQuotedText(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1] ?? null
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    if (/^[ \t]*>/.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * The issues a task was asked to close: every closing line in the messages
 * the person sent it, outside quoted and fenced text — an issue body or a CI
 * log carried into a message can hold closing lines of its own. A task
 * started from an issue carries one in its brief.
 */
export function closingIssuesFrom(items: readonly UiItem[]): number[] {
  const out: number[] = []
  for (const item of items) {
    if (item.kind !== 'message' || item.role !== 'user') continue
    for (const match of withoutQuotedText(item.content).matchAll(CLOSING_LINE)) {
      const n = Number(match[1])
      if (n > 0 && !out.includes(n)) out.push(n)
    }
  }
  return out
}

/** The task's latest finished result — what a PR drafted from it summarises; '' when there is none. */
export function latestResultText(items: readonly UiItem[]): string {
  if (items.length === 0) return ''
  const runs = buildRecordModel(items as UiItem[], { running: false }).runs
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const result = runs[i]!.result
    if (result && !result.streaming && result.text.trim()) return result.text
  }
  return ''
}

/** GitHub's title field; a longer one is refused by the create call. */
const TITLE_MAX = 256

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The PR title: the task's title, else the summary's first line as words —
 * its heading, bullet, bold, code ticks and `[[path]]` citations dropped, as
 * the navigator drops them from a task's title. Empty when neither has words.
 */
export function prTitleFrom(source: PrDraftSource): string {
  const fromTitle = oneLine(source.title ?? '')
  const firstLine = stripGoalMarkdown(source.summary)
  const title = fromTitle || oneLine(firstLine)
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title
}

function checkLine(check: DoneWhenCheck): string {
  const text = oneLine(check.text)
  const evidence = check.evidence ? oneLine(check.evidence) : ''
  if (check.verdict === 'met') return `- [x] ${text}${evidence ? `\n  Evidence: ${evidence}` : ''}`
  if (check.verdict === 'not_met') return `- [ ] ${text} (not met)${evidence ? `\n  Evidence: ${evidence}` : ''}`
  return `- [ ] ${text} (not checked)`
}

/**
 * The PR description: the summary as written, then the done-when checks —
 * met ticked, unmet and unchecked left open and said so in words, each with
 * the evidence the agent recorded. Empty when there is no summary, so the
 * caller falls back to gh's `--fill`.
 */
export function prBodyFrom(source: PrDraftSource): string {
  const summary = source.summary.trim()
  if (!summary) return ''
  const body = source.checks.length === 0 ? summary : `${summary}\n\n## Done when\n\n${source.checks.map(checkLine).join('\n')}`
  // Each issue the task was asked to fix, said the way GitHub closes it on merge.
  const said = new Set(closingIssuesFrom([{ kind: 'message', id: '', role: 'user', content: body }]))
  const closes = (source.closes ?? []).filter((n) => !said.has(n))
  return closes.length > 0 ? `${body}\n\n${closes.map((n) => `Fixes #${n}`).join('\n')}` : body
}
