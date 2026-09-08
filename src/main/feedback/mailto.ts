import type { FeedbackType } from '../../shared/ipc'

export interface FeedbackMailtoInput {
  type: FeedbackType
  title: string
  message: string
  includeDiagnostics: boolean
  appVersion: string
  os: string
  locale: string
  now?: Date
}

export const FEEDBACK_EMAIL = 'vyotiq@gmail.com'

/**
 * Pure mailto builder for the feedback service.
 *
 * Subject: `[Vyotiq <appVersion>] <type>: <title>`; body is the user message,
 * optionally followed by an app-diagnostics block (version, OS, locale,
 * timestamp). Diagnostics never include chat or conversation content — only
 * the metadata passed in via the input.
 */
export function buildFeedbackMailto(input: FeedbackMailtoInput): string {
  const subject = `[Vyotiq ${input.appVersion}] ${input.type}: ${input.title}`
  let body = input.message
  if (input.includeDiagnostics) {
    const timestamp = (input.now ?? new Date()).toISOString()
    body += [
      '',
      '',
      '---',
      `App version: ${input.appVersion}`,
      `OS: ${input.os}`,
      `Locale: ${input.locale}`,
      `Timestamp: ${timestamp}`
    ].join('\n')
  }
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
