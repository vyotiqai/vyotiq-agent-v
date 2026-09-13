/**
 * Stale-chunk recovery.
 *
 * A rebuild (`pnpm build` / packaged update) replaces `out/renderer` while a
 * window is still running the old entry. The old entry references chunks by
 * content hash, so the next lazy import (FilesPanel, TextCodeEditor, …) fails
 * with "Failed to fetch dynamically imported module: file://…/assets/X.js"
 * and the surface crashes. The new build is already on disk, so one reload
 * re-enters on the fresh entry chunk. The once-per-session guard keeps that
 * automatic reload from looping (e.g. when a build is still mid-write).
 */

const STALE_CHUNK_RELOAD_FLAG = 'vyotiq-stale-chunk-reload'

/** Lowercased substrings used by Chromium for failed module-script fetches. */
const STALE_CHUNK_PATTERNS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module'
]

export function isStaleChunkFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : undefined
  if (!message) return false
  const lower = message.toLowerCase()
  return STALE_CHUNK_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * Consume the single automatic reload allowance for this window session.
 * Returns true only the first time (per sessionStorage lifetime, i.e. per
 * reload cycle), and fails open when storage is unavailable.
 */
export function takeStaleChunkReload(): boolean {
  try {
    if (sessionStorage.getItem(STALE_CHUNK_RELOAD_FLAG) === '1') return false
    sessionStorage.setItem(STALE_CHUNK_RELOAD_FLAG, '1')
    return true
  } catch {
    return true
  }
}

/** Re-arm the automatic reload (explicit user-initiated recovery). */
export function rearmStaleChunkReload(): void {
  try {
    sessionStorage.removeItem(STALE_CHUNK_RELOAD_FLAG)
  } catch {
    // ignore — nothing to re-arm without storage
  }
}

export function resetStaleChunkReloadFlagForTests(): void {
  rearmStaleChunkReload()
}

export function reloadWindow(): void {
  window.location.reload()
}
