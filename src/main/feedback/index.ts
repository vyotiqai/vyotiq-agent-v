import { app, shell } from 'electron'
import { release as osRelease, type as osType } from 'os'
import type { FeedbackComposeRequest } from '../../shared/ipc'
import { buildFeedbackMailto } from './mailto'

/**
 * `feedback:compose` — build the mailto URL from validated renderer input plus
 * app metadata, then hand it to the OS mail handler. Returns the exact URL
 * that was opened.
 */
export async function composeFeedback(input: FeedbackComposeRequest): Promise<string> {
  const mailto = buildFeedbackMailto({
    ...input,
    appVersion: app.getVersion(),
    os: `${osType()} ${osRelease()} (${process.arch})`,
    locale: app.getLocale()
  })
  await shell.openExternal(mailto)
  return mailto
}
