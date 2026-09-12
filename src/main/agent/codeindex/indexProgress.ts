import type { CodeIndexSyncProgress } from '../../../shared/ipc/schemas/settings'
import { setCodeIndexRuntimeStatus } from './status'

const THROTTLE_MS = 75

let lastPublishAt = 0

export type IndexProgressStage = CodeIndexSyncProgress['stage']

export type IndexProgressUpdate = {
  stage: IndexProgressStage
  filesDone: number
  filesTotal: number
  indexed: number
  skipped: number
  removed?: number
  currentPath?: string | null
}

function fraction(done: number, total: number): number | null {
  if (total <= 0) return null
  return Math.min(0.99, Math.max(0, done / total))
}

function formatMessage(p: CodeIndexSyncProgress): string {
  const counts = `${p.filesDone}/${p.filesTotal} files · ${p.indexed} updated · ${p.skipped} skipped`
  if (p.stage === 'walking') return 'Walking workspace (code index)…'
  if (p.stage === 'reconciling') return `Reconciling removed files · ${counts}`
  if (p.stage === 'done') {
    const removed = p.removed > 0 ? ` · ${p.removed} removed` : ''
    return `Code index ready · ${p.indexed} updated · ${p.skipped} skipped${removed}`
  }
  const path = p.currentPath ? ` · ${p.currentPath}` : ''
  return `Indexing code · ${counts}${path}`
}

/** Push live indexing progress (throttled). Use force for stage boundaries / completion. */
export function publishIndexSyncProgress(
  update: IndexProgressUpdate,
  opts?: { force?: boolean }
): void {
  const now = Date.now()
  if (!opts?.force && now - lastPublishAt < THROTTLE_MS) return
  lastPublishAt = now

  const indexProgress: CodeIndexSyncProgress = {
    stage: update.stage,
    filesDone: update.filesDone,
    filesTotal: update.filesTotal,
    indexed: update.indexed,
    skipped: update.skipped,
    removed: update.removed ?? 0,
    currentPath: update.currentPath ?? null
  }

  setCodeIndexRuntimeStatus({
    phase: 'syncing',
    progress: fraction(update.filesDone, update.filesTotal),
    message: formatMessage(indexProgress),
    error: null,
    indexProgress
  })
}

export function clearIndexSyncProgress(): void {
  lastPublishAt = 0
  setCodeIndexRuntimeStatus({
    indexProgress: null
  })
}
