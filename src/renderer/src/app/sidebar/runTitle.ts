import type { RunSummary } from '@shared/ipc'
import { formatAgentInstanceShortId } from '@shared/utils/agentInstance'

const SCOPE_LINE_PREFIX =
  /^(?:AUDIT(?:\s*\/\s*RESPAWN)?\s+SCOPE|PATH\s+SCOPE|SCOPE)\s*:\s*/i
const SPAWN_PREFIX =
  /^(?:Spawn(?:ed)?(?:\s+multiple)?(?:\s+parallel)?\s+instances?\s+for\s*:\s*)/i
const PATH_SCOPE_FOOTER = /^Path scope \(writes must stay within/i
const MAX_INSTANCE_TITLE = 48

/** First-line plain text from a run goal (strip common markdown chrome). */
export function stripGoalMarkdown(goal: string): string {
  let s = goal.trim().split(/\r?\n/, 1)[0] ?? ''
  s = s.replace(/^#{1,6}\s+/, '')
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/\*(.+?)\*/g, '$1')
  s = s.replace(/_(.+?)_/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/^>\s+/, '')
  s = s.replace(/^[-*+]\s*\[[ xX]\]\s+/, '')
  s = s.replace(/^[-*+]\s+/, '')
  s = s.replace(/^\d+\.\s+/, '')
  return s.replace(/\s+/g, ' ').trim()
}

function clipTitle(text: string, max = MAX_INSTANCE_TITLE): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function looksLikePathList(line: string): boolean {
  return /\*\*/.test(line) || /,(?:[^,]+\.(?:md|ts|tsx|js|json|yml|yaml))\b/i.test(line)
}

function normalizeGoalLine(raw: string): string | null {
  let line = stripGoalMarkdown(raw)
  if (!line) return null
  if (PATH_SCOPE_FOOTER.test(line)) return null
  line = line.replace(SCOPE_LINE_PREFIX, '').trim()
  line = line.replace(SPAWN_PREFIX, '').trim()
  if (!line) return null
  return line
}

function goalLines(goal: string): string[] {
  const out: string[] = []
  for (const raw of goal.split(/\r?\n/)) {
    const line = normalizeGoalLine(raw)
    if (line) out.push(line)
  }
  return out
}

/** Compact path_scope fragment for sidebar labels (last 1–2 segments). */
export function pathScopeLabel(pathScope: string[] | undefined): string | undefined {
  if (!pathScope?.length) return undefined
  const first = pathScope[0].replace(/\\/g, '/').replace(/\/+$/, '').trim()
  if (!first) return undefined
  const parts = first.split('/').filter(Boolean)
  const compact =
    parts.length > 2 ? parts.slice(-2).join('/') : parts.length > 0 ? parts.join('/') : first
  return clipTitle(compact, 28)
}

function namedInstanceHead(lines: string[]): string | undefined {
  for (const plain of lines) {
    const partition = /^(Audit-?partition\s+\S+(?:\s*\([^)]{1,60}\))?)/i.exec(plain)
    if (partition?.[1]) return partition[1].trim()
  }
  for (const plain of lines) {
    const labeled = /^([A-Za-z][\w -]{2,40}?\([^)]{1,50}\))/.exec(plain)
    if (labeled?.[1]) return labeled[1].trim()
  }
  for (const plain of lines) {
    const lettered = /^(?:Partition\s+)?([A-Z])\s*[):.—–-]\s+(.+)$/i.exec(plain)
    if (lettered?.[1] && lettered[2]) {
      return `Partition ${lettered[1].toUpperCase()} (${clipTitle(lettered[2], 36)})`
    }
  }
  return undefined
}

/**
 * Compact sidebar/header title for inline instances.
 * Prefers partition heads, then path_scope, then a short clean line — never raw SCOPE dumps.
 */
export function instanceDisplayTitle(
  goal: string | undefined,
  runId: string,
  pathScope?: string[]
): string {
  const lines = goal?.trim() ? goalLines(goal) : []
  const named = namedInstanceHead(lines)
  if (named) return named

  const scope = pathScopeLabel(pathScope)
  if (scope) return scope

  for (const plain of lines) {
    if (looksLikePathList(plain)) {
      const firstPath = plain.split(',')[0]?.trim()
      if (firstPath) return clipTitle(firstPath, 32)
      continue
    }
    const ofThe = /^(.{8,48}?)\s+of the\b/i.exec(plain)
    if (ofThe?.[1]) return ofThe[1].trim()
    if (plain.length <= MAX_INSTANCE_TITLE) return plain
    return clipTitle(plain)
  }

  return formatAgentInstanceShortId(runId)
}

/**
 * Ensure sibling instance rows stay distinguishable when goals collapse to the same label.
 */
export function uniqueInstanceTitles(runs: RunSummary[]): Map<string, string> {
  const base = new Map<string, string>()
  for (const run of runs) {
    base.set(run.runId, instanceDisplayTitle(run.goal, run.runId, run.pathScope))
  }

  const counts = new Map<string, number>()
  for (const title of base.values()) {
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }

  const out = new Map<string, string>()
  const used = new Map<string, number>()
  for (const run of runs) {
    let title = base.get(run.runId) ?? formatAgentInstanceShortId(run.runId)
    if ((counts.get(title) ?? 0) > 1) {
      const scope = pathScopeLabel(run.pathScope)
      const shortId = formatAgentInstanceShortId(run.runId)
      title = scope && scope !== title ? scope : shortId
    }
    const n = (used.get(title) ?? 0) + 1
    used.set(title, n)
    if (n > 1) {
      title = `${title} · ${formatAgentInstanceShortId(run.runId)}`
    }
    out.set(run.runId, title)
  }
  return out
}

function parentDisplayTitle(goal: string): string {
  let plain = stripGoalMarkdown(goal)
  plain = plain.replace(SPAWN_PREFIX, '').trim()
  return plain || goal.trim()
}

export function runTitle(run: RunSummary): string {
  const goal = run.goal?.trim()
  if (run.inlineInstance) {
    return instanceDisplayTitle(goal, run.runId, run.pathScope)
  }
  if (!goal) return run.runId.slice(0, 8)
  // Full plain title — row CSS `truncate` + tooltip handle overflow (no dual cut).
  return parentDisplayTitle(goal)
}

export function runTooltip(run: RunSummary): string {
  const goal = run.goal?.trim()
  if (run.inlineInstance) {
    const plain = goal
      ? (goalLines(goal)[0] ?? (stripGoalMarkdown(goal) || goal))
      : run.runId
    const scope = pathScopeLabel(run.pathScope)
    return scope ? `Instance · ${plain} · ${scope}` : `Instance · ${plain}`
  }
  if (!goal) return run.runId
  return parentDisplayTitle(goal)
}

/** Lowercase plain text for sidebar search — matches displayed title, not raw goal. */
export function runSearchText(run: RunSummary): string {
  const goal = run.goal?.trim()
  if (!goal) return run.runId.toLowerCase()
  const plain = (stripGoalMarkdown(goal) || goal).toLowerCase()
  if (run.inlineInstance) {
    return `${instanceDisplayTitle(goal, run.runId, run.pathScope).toLowerCase()} ${plain} ${run.runId.toLowerCase()}`
  }
  return parentDisplayTitle(goal).toLowerCase()
}
