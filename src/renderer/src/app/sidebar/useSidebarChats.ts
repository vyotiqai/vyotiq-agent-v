import { useMemo } from 'react'
import { groupRunsByRecency } from '@renderer/lib/utils/groupRunsByRecency'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { findByWorkspacePath, workspacePathsEqual } from '@shared/workspacePathMatch'
import { runSearchText } from './runTitle'
import type { WorkspaceSidebarGroup, WorkspaceSidebarRuns } from './types'

type UseSidebarChatsInput = {
  openPaths: string[]
  activePath: string | null
  sessionQuery: string
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>
  expandedByPath: Record<string, boolean>
}

export function useSidebarChats({
  openPaths,
  activePath,
  sessionQuery,
  runsByWorkspacePath,
  expandedByPath
}: UseSidebarChatsInput) {
  const workspaceGroups = useMemo<WorkspaceSidebarGroup[]>(() => {
    const q = sessionQuery.trim().toLowerCase()
    return openPaths.map((path) => {
      const workspaceRuns = findByWorkspacePath(runsByWorkspacePath, path) ?? {
        runs: [],
        activeRunId: null
      }
      const instanceRuns = workspaceRuns.instanceRuns ?? []
      const filteredInstances = q
        ? instanceRuns.filter((r) => runSearchText(r).includes(q))
        : instanceRuns
      // Keep parents that match, or parents of matching instance children.
      const parentIdsFromInstances = new Set(
        filteredInstances.map((r) => r.parentRunId).filter((id): id is string => Boolean(id))
      )
      const parentsForList = q
        ? workspaceRuns.runs.filter(
            (r) => runSearchText(r).includes(q) || parentIdsFromInstances.has(r.runId)
          )
        : workspaceRuns.runs
      const groupedRuns = q
        ? parentsForList.length
          ? [{ id: 'today' as const, label: 'Results', runs: parentsForList }]
          : []
        : groupRunsByRecency(parentsForList)
      const expanded = q
        ? true
        : expandedByPath[path] ??
          (activePath != null && workspacePathsEqual(path, activePath))
      return {
        path,
        label: formatWorkspaceName(path, path),
        isActiveWorkspace: activePath != null && workspacePathsEqual(path, activePath),
        expanded,
        filteredRuns: parentsForList,
        instanceRuns: filteredInstances,
        groupedRuns,
        runsCapped: workspaceRuns.runsCapped,
        runsError: workspaceRuns.runsError,
        runsLoaded: workspaceRuns.runsLoaded,
        activeRunId: workspaceRuns.activeRunId
      }
    })
  }, [activePath, expandedByPath, openPaths, runsByWorkspacePath, sessionQuery])

  const filteredRuns = useMemo(
    () => workspaceGroups.flatMap((group) => group.filteredRuns),
    [workspaceGroups]
  )

  return { filteredRuns, workspaceGroups }
}
