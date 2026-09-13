import { wrapUntrustedContent } from '../agent/untrustedContent'

/**
 * Wrap page-sourced browser tool output so models treat it as untrusted data.
 */
export function wrapBrowserPageContent(
  body: string,
  opts: { origin?: string; kind?: string } = {}
): string {
  return wrapUntrustedContent(body, {
    source: 'browser',
    origin: opts.origin,
    kind: opts.kind ?? 'page'
  })
}
