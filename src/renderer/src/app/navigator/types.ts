import type { RunSummary } from '@shared/ipc'

/** One open workspace's task list as the renderer holds it. */
export type WorkspaceRuns = {
  runs: RunSummary[]
  instanceRuns?: RunSummary[]
  runsCapped?: boolean
  runsError?: string | null
  runsLoaded?: boolean
  activeRunId: string | null
}
