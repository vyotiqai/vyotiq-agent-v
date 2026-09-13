/**
 * Lower OS scheduling priority for background indexer / terminal processes.
 * Best-effort: failures must never break the caller.
 */
import { constants, setPriority } from 'node:os'

/** Windows BELOW_NORMAL / Unix nice ≈ 10 via Node priority constants. */
export function lowerProcessPriority(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    const below = constants.priority?.PRIORITY_BELOW_NORMAL
    if (typeof below === 'number') {
      setPriority(pid, below)
      return true
    }
    setPriority(pid, 10)
    return true
  } catch {
    return false
  }
}

/** Restore normal scheduling priority after a temporary lower. */
export function restoreProcessPriority(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    const normal = constants.priority?.PRIORITY_NORMAL
    if (typeof normal === 'number') {
      setPriority(pid, normal)
      return true
    }
    setPriority(pid, 0)
    return true
  } catch {
    return false
  }
}
