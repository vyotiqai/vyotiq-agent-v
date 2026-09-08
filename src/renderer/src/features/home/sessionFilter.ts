import type { RunSummary } from '@shared/ipc'
import { runTitle } from '@renderer/app/sidebar/runTitle'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'

export function filterRecentEntries<T extends { workspacePath: string; run: RunSummary }>(
  entries: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...entries]
  return entries.filter((entry) => {
    const title = runTitle(entry.run).toLowerCase()
    const workspaceName = formatWorkspaceName(entry.workspacePath).toLowerCase()
    return title.includes(needle) || workspaceName.includes(needle)
  })
}
