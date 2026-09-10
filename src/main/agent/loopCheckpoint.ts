import { existsSync, readFileSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import { logger } from '../../shared/logger'
import { LoopCheckpointSchema, LOOP_CHECKPOINT_VERSION, type LoopCheckpoint } from '@shared/ipc/schemas/agent'

export const LOOP_CHECKPOINT_FILENAME = 'loopCheckpoint.json'

function checkpointPath(runDir: string): string {
  return join(runDir, LOOP_CHECKPOINT_FILENAME)
}

export function loadLoopCheckpoint(runDir: string): LoopCheckpoint | null {
  const path = checkpointPath(runDir)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    // v1→v2 / v2→v3: loop invariants carried forward; v3 adds optional
    // usageTotals (absent in older files → undefined, fine). Accept earlier
    // versions by overwriting the literal so resume keeps restoring state.
    if (raw.version === 1 || raw.version === 2) raw.version = LOOP_CHECKPOINT_VERSION
    const parsed = LoopCheckpointSchema.safeParse(raw)
    if (!parsed.success) throw parsed.error
    return parsed.data
  } catch (err) {
    logger.warn('Corrupt loopCheckpoint.json; treating as absent', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
}

export function saveLoopCheckpoint(runDir: string, checkpoint: LoopCheckpoint): void {
  atomicWriteJson(checkpointPath(runDir), checkpoint)
}

export function clearLoopCheckpoint(runDir: string): void {
  const path = checkpointPath(runDir)
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // ignore missing or locked file
  }
}
