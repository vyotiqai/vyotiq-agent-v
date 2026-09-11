export type AgentInstanceUiState = {
  instanceRunId: string
  phase: 'started' | 'done' | 'error' | 'cancelled'
  goal?: string
  summary?: string
  pathScope?: string[]
}

export function formatAgentInstanceLabel(runId: string): string {
  // Full run_id stays first and machine-parsable (parseAgentInstanceRunId captures
  // the token right after the label); the short id is the ledger-chip prefix so
  // timeout/error text correlates with instance rows in the UI.
  return `Agent V Instance id; ${runId} (short ${formatAgentInstanceShortId(runId)})`
}

/** Short prefix for tool headers and compact rows (first UUID segment). */
export function formatAgentInstanceShortId(runId: string): string {
  const trimmed = runId.trim()
  if (!trimmed) return runId
  const segment = trimmed.split('-')[0]
  return segment && segment.length >= 4 ? segment : trimmed.slice(0, 8)
}

export function parseAgentInstanceRunIdFromArgs(argsPreview?: string | null): string | null {
  if (!argsPreview?.trim()) return null
  try {
    const parsed = JSON.parse(argsPreview) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const runId = record.run_id ?? record.runId
    return typeof runId === 'string' && runId.trim() ? runId.trim() : null
  } catch {
    return null
  }
}

export function parseAgentInstanceRunId(content?: string): string | null {
  if (!content) return null
  const labeled = /Agent V Instance id;\s*(\S+)/i.exec(content)
  if (labeled?.[1]) return labeled[1]
  const runIdLine = /run_id:\s*(\S+)/i.exec(content)
  return runIdLine?.[1] ?? null
}
