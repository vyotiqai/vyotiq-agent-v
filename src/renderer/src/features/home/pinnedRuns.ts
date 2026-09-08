/** Session pin key — disambiguates the same run id across workspaces. */
export function pinnedRunKey(workspacePath: string, runId: string): string {
  return `${workspacePath}\u0000${runId}`
}

/** Settings cap — the newest pins win. */
export const PINNED_RUNS_CAP = 24

/** Toggle a pin; adding beyond the cap drops the oldest pins. */
export function togglePinnedRun(keys: readonly string[], key: string): string[] {
  return keys.includes(key)
    ? keys.filter((k) => k !== key)
    : [...keys, key].slice(-PINNED_RUNS_CAP)
}

/** Drop a deleted session's pin; identity-stable when nothing changed. */
export function prunePinnedRun(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : keys
}
