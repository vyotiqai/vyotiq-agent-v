import { protocol } from 'electron'
import { randomBytes } from 'crypto'
import { basename } from 'path'
import { MEDIA_SCHEME } from './schemes'
import { mediaMimeForPath, serveFileResponse } from './serveFile'

/**
 * `vyotiq-media://m/<token>/<name>` — how the app window plays a video.
 *
 * A data URL would put a whole file through IPC and into renderer memory, and
 * the renderer CSP allows no `blob:`. This scheme streams instead, with Range
 * support so the player can seek. It serves only files main has registered
 * (after checking them against an open workspace); a token is 128 random
 * bits, so the URL itself grants nothing that main did not hand out.
 */

type Entry = { path: string; mime: string }

const byToken = new Map<string, Entry>()
const byPath = new Map<string, string>()
const MAX_ENTRIES = 512

export function mediaUrlFor(absPath: string): string | null {
  const mime = mediaMimeForPath(absPath)
  if (!mime) return null
  let token = byPath.get(absPath)
  if (!token) {
    token = randomBytes(16).toString('hex')
    byPath.set(absPath, token)
    byToken.set(token, { path: absPath, mime })
    while (byToken.size > MAX_ENTRIES) {
      const oldest = byToken.keys().next().value
      if (oldest === undefined) break
      const entry = byToken.get(oldest)
      byToken.delete(oldest)
      if (entry) byPath.delete(entry.path)
    }
  }
  return `${MEDIA_SCHEME}://m/${token}/${encodeURIComponent(basename(absPath))}`
}

export function handleMediaRequest(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }
  const url = new URL(request.url)
  const token = url.pathname.split('/').filter(Boolean)[0] ?? ''
  const entry = url.host === 'm' ? byToken.get(token) : undefined
  if (!entry) return new Response('Not found', { status: 404 })
  return serveFileResponse(request, entry.path, entry.mime)
}

/** Call once after `app.whenReady()`, on the default session the app window uses. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
}

export function resetMediaRegistryForTests(): void {
  byToken.clear()
  byPath.clear()
}
