import type { DoneWhenCheck } from '@shared/doneWhenChecks'

/** What the PR panel writes a draft pull request from: the task's own words. */
export type PrDraftSource = {
  /** The task's title, when it has one. */
  title?: string | null
  /** The run's result: the last thing the agent said once the run ended. */
  summary: string
  checks: readonly DoneWhenCheck[]
}

/** GitHub's title field; a longer one is refused by the create call. */
const TITLE_MAX = 256

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The PR title: the task's title, else the summary's first line without its
 * markdown heading marks. Empty when neither has words.
 */
export function prTitleFrom(source: PrDraftSource): string {
  const fromTitle = oneLine(source.title ?? '')
  const firstLine =
    source.summary
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim())
      .find((line) => line.length > 0) ?? ''
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
  if (source.checks.length === 0) return summary
  return `${summary}\n\n## Done when\n\n${source.checks.map(checkLine).join('\n')}`
}
