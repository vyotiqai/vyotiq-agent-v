import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import type { IconName } from '@renderer/lib/icons'

/**
 * Instructions the app writes for you and sends as a follow-up — an open
 * check's "Ask it to cover this", a failed turn's "Ask it to mock Redis", a
 * failing pull request check's "Hand to agent". Each is built here and read
 * back here, so the record can say what was asked ("Make check c14 pass")
 * instead of setting a paragraph you never typed as if you had. One you edit
 * before sending no longer reads back: it is your own words then.
 */

/** What "Ask it to cover this" sends: the check, what the agent saw, and what to do. */
export function coverCheckInstruction(check: Pick<DoneWhenCheck, 'id' | 'text' | 'verdict' | 'evidence'>): string {
  if (check.verdict === 'not_met') {
    const seen = check.evidence ? ` It saw: ${check.evidence}` : ''
    return `The done-when check ${check.id} "${check.text}" is not met.${seen} Make it pass, then check it again with its evidence.`
  }
  return `The done-when check ${check.id} "${check.text}" was never checked. Check it now and mark it met or not met, with the evidence.`
}

/** What a failing pull request check's "Hand to agent" sends. */
export function prCheckInstruction(check: { name: string; description?: string | null; url?: string | null }, prNumber: number | null): string {
  return (
    `The “${check.name}” check failed on pull request #${prNumber ?? ''}${check.description ? ` (${check.description})` : ''}. ` +
    `Read its log${check.url ? ` at ${check.url}` : ''}, find the cause and fix it.`
  )
}

/** What a pull request review thread's "Hand to agent" / "Address all unresolved" needs of it. */
export type ReviewThreadForInstruction = {
  path: string
  line: number | null
  originalLine: number | null
  isOutdated: boolean
  comments: ReadonlyArray<{ author: string; body: string; url: string | null }>
}

/** A comment's own words, capped; later lines indented under its list item. */
const REVIEW_COMMENT_CAP = 2_000
const REVIEW_REPLY_CAP = 300
const REVIEW_REPLIES_SHOWN = 3

function reviewThreadLocation(thread: ReviewThreadForInstruction): string {
  const line = thread.line ?? thread.originalLine
  return `${thread.path}${line != null ? `:${line}` : ''}`
}

function capText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap).trimEnd()}…` : text
}

function reviewThreadItem(thread: ReviewThreadForInstruction): string {
  const [first, ...replies] = thread.comments
  const outdated = thread.isOutdated ? ' (outdated: the line has changed since)' : ''
  const body = capText((first?.body ?? '').replace(/\r\n?/g, '\n').trim(), REVIEW_COMMENT_CAP)
  const [head = '', ...rest] = body.split('\n')
  const lines = [`- ${reviewThreadLocation(thread)}${outdated} — ${first?.author ?? 'unknown'}: ${head}`]
  for (const line of rest) lines.push(line.trim() ? `  ${line}` : '')
  for (const reply of replies.slice(-REVIEW_REPLIES_SHOWN)) {
    const said = capText(reply.body.replace(/\s+/g, ' ').trim(), REVIEW_REPLY_CAP)
    lines.push(`  ↳ ${reply.author}: ${said}`)
  }
  if (first?.url) lines.push(`  ${first.url}`)
  return lines.join('\n')
}

/**
 * What a review thread's "Hand to agent" (one thread) or "Address all
 * unresolved" (several) sends: each as `path:line — author: comment` with its
 * link. It asks for no reply on GitHub — a reply posts publicly, so that stays
 * the person's own button.
 */
export function prReviewInstruction(threads: readonly ReviewThreadForInstruction[], prNumber: number | null): string {
  const n = threads.length
  const head =
    n === 1
      ? `Address the review comment on pull request #${prNumber ?? ''}:`
      : `Address the ${n} unresolved review comments on pull request #${prNumber ?? ''}:`
  const tail =
    n === 1
      ? 'Make the change it asks for, or tell me why not. Do not reply on GitHub or resolve the thread.'
      : 'For each, make the change it asks for, or tell me why not. Do not reply on GitHub or resolve the threads.'
  return [head, ...threads.map(reviewThreadItem), tail].join('\n')
}

/** A follow-up the app wrote, as the record says it. */
export type FollowUpOrigin = {
  kind: 'check' | 'mock' | 'prCheck' | 'prReview'
  icon: IconName
  /** What it asked, in a few words: "Make check c14 pass". */
  ask: string
  /** The thing it is about, when there is more to it than the ask: the check's own words. */
  about?: string
}

const CHECK_NOT_MET =
  /^The done-when check (\S+) "([\s\S]*)" is not met\.(?: It saw: [\s\S]*?)? Make it pass, then check it again with its evidence\.$/
const CHECK_OPEN =
  /^The done-when check (\S+) "([\s\S]*)" was never checked\. Check it now and mark it met or not met, with the evidence\.$/
/** `mockServiceInstruction` (shared/utils/unreachableService). */
const MOCK = /^Mock ([\s\S]+?) instead of connecting to it, so the work can be verified without it, then carry on\.$/
const PR_CHECK =
  /^The “([\s\S]+?)” check failed on pull request #(\d*)(?: \(([\s\S]*?)\))?\. Read its log(?: at \S+)?, find the cause and fix it\.$/
const PR_REVIEW =
  /^Address (?:the review comment|the (\d+) unresolved review comments) on pull request #(\d*):\n([\s\S]+)\n(?:Make the change it asks for, or tell me why not\. Do not reply on GitHub or resolve the thread\.|For each, make the change it asks for, or tell me why not\. Do not reply on GitHub or resolve the threads\.)$/

/** The follow-up the app wrote that `text` is, unchanged; null for anything you wrote. */
export function followUpOrigin(text: string): FollowUpOrigin | null {
  const said = text.trim()
  let m = CHECK_NOT_MET.exec(said)
  if (m) return { kind: 'check', icon: 'checklist', ask: `Make check ${m[1]} pass`, about: m[2] }
  m = CHECK_OPEN.exec(said)
  if (m) return { kind: 'check', icon: 'checklist', ask: `Check ${m[1]}`, about: m[2] }
  m = MOCK.exec(said)
  if (m) return { kind: 'mock', icon: 'plug', ask: `Mock ${m[1]} instead of connecting to it` }
  m = PR_CHECK.exec(said)
  if (m) {
    return {
      kind: 'prCheck',
      icon: 'pullRequest',
      ask: `Fix the failing “${m[1]}” check${m[2] ? ` on #${m[2]}` : ''}`,
      ...(m[3] ? { about: m[3] } : {})
    }
  }
  m = PR_REVIEW.exec(said)
  if (m) {
    // Each thread's list item starts at the margin; its comment's later lines are indented.
    const places = m[3]!
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).split(' — ')[0]!.replace(/ \(outdated: [^)]*\)$/, ''))
    const on = m[2] ? ` on #${m[2]}` : ''
    return {
      kind: 'prReview',
      icon: 'chat',
      ask: m[1] ? `Address ${m[1]} review comments${on}` : `Address the review comment${on}`,
      ...(places.length ? { about: places.join('\n') } : {})
    }
  }
  return null
}
