import { RunIdSchema } from './ipc/schemas/agent'
import { canonicalizeWorkspacePath } from './utils/workspacePath'

export const DEEP_LINK_SCHEME = 'vyotiq'
export const DEEP_LINK_RUN_HOST = 'run'

/** A parsed deep-link target. `workspacePath` is null when the URL omitted `ws`. */
export type DeepLinkRunTarget = {
  type: 'open_run'
  workspacePath: string | null
  runId: string
}

/**
 * Parse a `vyotiq://run/<runId>?ws=<encoded workspace path>` URL into a target.
 * Returns null for anything that is not a well-formed vyotiq run link.
 */
export function parseDeepLinkUrl(raw: string): DeepLinkRunTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  if (url.hostname !== DEEP_LINK_RUN_HOST) return null
  let runId: string
  try {
    runId = decodeURIComponent(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
  } catch {
    // Malformed percent-sequences are untrusted input, not a crash.
    return null
  }
  const parsedRunId = RunIdSchema.safeParse(runId)
  if (!parsedRunId.success) return null
  const rawWs = url.searchParams.get('ws')
  const workspacePath =
    rawWs && rawWs.trim().length > 0 ? canonicalizeWorkspacePath(rawWs.trim()) : null
  return { type: 'open_run', workspacePath, runId: parsedRunId.data }
}

/** Build a `vyotiq://run/...` deep link for a run in a workspace. */
export function buildRunDeepLink(workspacePath: string, runId: string): string {
  const parsed = RunIdSchema.safeParse(runId)
  if (!parsed.success) throw new Error('Invalid run id')
  return `${DEEP_LINK_SCHEME}://${DEEP_LINK_RUN_HOST}/${encodeURIComponent(
    runId
  )}?ws=${encodeURIComponent(canonicalizeWorkspacePath(workspacePath))}`
}

/** Find a `vyotiq://` URL among process/second-instance argv entries (Windows/Linux). */
export function extractDeepLinkUrlFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const entry = argv[i]
    if (typeof entry === 'string' && entry.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) {
      return entry
    }
  }
  return null
}
