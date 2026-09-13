import type { SearchEngineId } from '../ipc/schemas/settings'

export function buildSearchUrl(engine: SearchEngineId, query: string): string {
  const q = encodeURIComponent(query.trim())
  switch (engine) {
    case 'bing':
      return `https://www.bing.com/search?q=${q}`
    case 'google':
      return `https://www.google.com/search?q=${q}`
    case 'duckduckgo':
    default:
      return `https://duckduckgo.com/?q=${q}`
  }
}

/** Address-bar input: URL as-is, file: as-is, host-like token as https, otherwise search. */
export function resolveAddressBarTarget(raw: string, engine: SearchEngineId): string {
  const target = raw.trim()
  if (!target) return ''
  if (/^https?:\/\//i.test(target)) return target
  // file:// links (workspace-scoped; the main process enforces containment).
  if (/^file:\/\//i.test(target)) return target
  if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(target)) return `https://${target}`
  return buildSearchUrl(engine, target)
}
