import { RunIdSchema } from './ipc/schemas/agent'
import { DEEP_LINK_BRIEF_MAX, type DeepLinkTarget } from './ipc/schemas/deepLink'
import { canonicalizeWorkspacePath } from './utils/workspacePath'

export const DEEP_LINK_SCHEME = 'vyotiq'
export const DEEP_LINK_RUN_HOST = 'run'
export const DEEP_LINK_OPEN_HOST = 'open'
export const DEEP_LINK_NEW_HOST = 'new'

/** A parsed deep-link target. `workspacePath` is null when the URL omitted `ws`. */
export type DeepLinkRunTarget = Extract<DeepLinkTarget, { type: 'open_run' }>

/** Longest URL accepted: room for a full brief once percent-encoded. */
const DEEP_LINK_URL_MAX = 4096 + DEEP_LINK_BRIEF_MAX * 3

function wsParam(url: URL): string | null {
  const raw = url.searchParams.get('ws')
  return raw && raw.trim().length > 0 ? canonicalizeWorkspacePath(raw.trim()) : null
}

/**
 * Parse a vyotiq:// URL into a target:
 * - `vyotiq://run/<runId>?ws=<path>` opens a task;
 * - `vyotiq://open?ws=<path>` opens a workspace;
 * - `vyotiq://new?ws=<path>&brief=<text>` opens New task with the brief filled in.
 * Returns null for anything that is not a well-formed vyotiq link.
 */
export function parseDeepLinkUrl(raw: string): DeepLinkTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > DEEP_LINK_URL_MAX) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  if (url.hostname === DEEP_LINK_OPEN_HOST) {
    const workspacePath = wsParam(url)
    return workspacePath ? { type: 'open_workspace', workspacePath, fromCommandLine: false } : null
  }
  if (url.hostname === DEEP_LINK_NEW_HOST) {
    const brief = (url.searchParams.get('brief') ?? '').trim()
    if (brief.length > DEEP_LINK_BRIEF_MAX) return null
    return { type: 'new_task', workspacePath: wsParam(url), brief }
  }
  if (raw.length > 4096) return null
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
