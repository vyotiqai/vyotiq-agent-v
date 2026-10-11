/**
 * The websocket every streaming voice adapter uses, opened in main with the
 * vendor's auth headers (the renderer CSP has no `wss:`; keys never leave
 * main). One seam for tests, like dictation's `setOpenLiveSocketForTests`.
 */

export type VoiceSocket = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

export type OpenVoiceSocket = (url: string, headers: Record<string, string>) => VoiceSocket

/** Node's global WebSocket (undici) accepts `headers` in its options object. */
const defaultOpen: OpenVoiceSocket = (url, headers) =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as VoiceSocket

let open: OpenVoiceSocket = defaultOpen

export function openVoiceSocket(url: string, headers: Record<string, string>): VoiceSocket {
  return open(url, headers)
}

export function setOpenVoiceSocketForTests(fn: OpenVoiceSocket | null): void {
  open = fn ?? defaultOpen
}

export const SOCKET_OPEN = 1

/** Parse a JSON frame; anything else is ignored. */
export function parseFrame(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
