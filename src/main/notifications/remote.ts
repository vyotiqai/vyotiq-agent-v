import type { NotificationItem, NotificationKind, RemoteNotificationMode } from '../../shared/ipc'
import { logger } from '../../shared/logger'

/**
 * Notifications that reach you away from this computer: an ntfy topic (the
 * ntfy app on a phone) or any webhook (Slack, Discord, Teams, a script).
 * The URL is a secret — anyone holding it can post to you — so it lives in
 * the key vault (tool key `notify`), never in settings.json.
 */

const REMOTE_TIMEOUT_MS = 10_000

type RemoteMessage = Pick<NotificationItem, 'kind' | 'title' | 'body'> & { createdAt?: string }

const NTFY_TAGS: Record<NotificationKind, string> = {
  needs_you: 'raising_hand',
  run_done: 'white_check_mark',
  run_error: 'x',
  crash: 'warning',
  update_ready: 'arrow_down',
  budget: 'moneybag'
}

/** ntfy priorities: a task waiting on you is worth a buzz; the rest is default. */
function ntfyPriority(kind: NotificationKind): number {
  return kind === 'needs_you' || kind === 'run_error' ? 4 : 3
}

/** Why `url` can't be used for `mode`, or null when it can. */
export function remoteUrlProblem(mode: Exclude<RemoteNotificationMode, 'off'>, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return 'That is not a URL.'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Use an https:// address.'
  if (parsed.username || parsed.password) return 'Leave the user name and password out of the address.'
  if (mode === 'ntfy' && parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length === 0) {
    return 'Add the topic: https://ntfy.sh/your-topic.'
  }
  return null
}

/**
 * The request for one message. ntfy takes JSON at its root with the topic
 * inside (headers can't carry a non-Latin title); a webhook gets one JSON body
 * that Slack (`text`), Discord (`content`) and a script (the rest) all read.
 */
export function buildRemoteRequest(
  mode: Exclude<RemoteNotificationMode, 'off'>,
  url: string,
  message: RemoteMessage
): { url: string; init: RequestInit } {
  const headers = { 'Content-Type': 'application/json' }
  if (mode === 'ntfy') {
    const parsed = new URL(url.trim())
    const parts = parsed.pathname.split('/').filter(Boolean)
    const topic = parts.pop() ?? ''
    const root = `${parsed.origin}/${parts.length > 0 ? `${parts.join('/')}/` : ''}`
    return {
      url: root,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          topic,
          title: message.title,
          message: message.body || message.title,
          tags: [NTFY_TAGS[message.kind]],
          priority: ntfyPriority(message.kind)
        })
      }
    }
  }
  const line = message.body ? `${message.title}\n${message.body}` : message.title
  return {
    url: url.trim(),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: line,
        content: line,
        app: 'Agent V',
        kind: message.kind,
        title: message.title,
        body: message.body,
        at: message.createdAt ?? new Date().toISOString()
      })
    }
  }
}

/** Post one message; throws with the server's status when it refuses. */
export async function sendRemoteNotification(
  mode: Exclude<RemoteNotificationMode, 'off'>,
  url: string,
  message: RemoteMessage,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const problem = remoteUrlProblem(mode, url)
  if (problem) throw new Error(problem)
  const request = buildRemoteRequest(mode, url, message)
  const res = await fetchImpl(request.url, { ...request.init, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`The server answered ${res.status}${detail ? `: ${detail}` : ''}`)
  }
}

let loggedFailure = false

/** Fire and forget from the notification path: one warning per session, never a throw. */
export function deliverRemoteNotification(
  mode: Exclude<RemoteNotificationMode, 'off'>,
  url: string,
  message: RemoteMessage
): void {
  sendRemoteNotification(mode, url, message).then(
    () => {
      loggedFailure = false
    },
    (err: unknown) => {
      if (loggedFailure) return
      loggedFailure = true
      logger.warn('Phone notification not delivered', { scope: 'notifications', err })
    }
  )
}
