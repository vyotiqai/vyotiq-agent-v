/**
 * Burst limits shared by `screen_snip` and `browser_snapshot`. Electron-free so
 * the tool schemas can import them.
 */

/** Frames one call may take. Each is an image the model is sent. */
export const SNIP_MAX_FRAMES = 6
export const SNIP_DEFAULT_INTERVAL_MS = 500
export const SNIP_MIN_INTERVAL_MS = 50
export const SNIP_MAX_INTERVAL_MS = 5_000

export function clampSnipFrames(frames: number | undefined): number {
  return Math.max(1, Math.min(SNIP_MAX_FRAMES, Math.round(frames ?? 1)))
}

export function clampSnipInterval(intervalMs: number | undefined): number {
  return Math.max(
    SNIP_MIN_INTERVAL_MS,
    Math.min(SNIP_MAX_INTERVAL_MS, Math.round(intervalMs ?? SNIP_DEFAULT_INTERVAL_MS))
  )
}
