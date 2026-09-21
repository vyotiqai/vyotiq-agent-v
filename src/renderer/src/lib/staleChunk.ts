import { logger } from '@shared/logger'
import { shouldLogErrorSignature } from '@renderer/logging/errorLogRateLimiter'

/**
 * Stale-chunk recovery.
 *
 * Vite addresses every lazy chunk and its CSS by content hash, so a window
 * whose chunks leave `out/renderer` cannot resolve its next lazy import
 * (FilesPanel, TextCodeEditor, …) and the surface crashes. A reload re-enters
 * on whatever entry is on disk now.
 *
 * Ordinary builds no longer cause this: the renderer builds with
 * `emptyOutDir: false` and collects superseded chunks only once they are old
 * enough that no window can still be running them (electron.vite.config.ts).
 * What is left is a packaged update, `pnpm pack:clean`, and a window that
 * outlived the retention window — rare, so recovery can be unhurried.
 *
 * Detection is event-first. Vite's preload helper dispatches a cancelable
 * `vite:preloadError` on window before it rethrows, for both a missing JS
 * chunk and a missing CSS dependency ("Unable to preload CSS for …"). Message
 * matching stays as a fallback for failures that arrive by another route — a
 * bare `import()` outside the preload helper, or an error React has already
 * unwrapped — and must therefore cover the CSS shape too.
 *
 * Reloads are rate-limited, not capped for the life of the window.
 * `sessionStorage` survives `location.reload()`, so a boolean flag granted one
 * reload *ever*: the second rebuild of a session landed on a crash screen. A
 * timestamped budget lets every rebuild recover while a genuine loop — a window
 * that fails again the moment it comes back — still stops after a few tries.
 */

const STALE_CHUNK_BUDGET_KEY = 'vyotiq-stale-chunk-reload'

/** Lowercased substrings Chromium and Vite use for failed chunk/CSS loads. */
const STALE_CHUNK_PATTERNS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
  'unable to preload css for'
]

/**
 * Reloads this far apart are separate rebuilds, not a loop. A recovered window
 * runs for minutes before the next build; a loop re-fails within seconds.
 */
export const STALE_CHUNK_RELOAD_COOLDOWN_MS = 20_000

/**
 * Back-off between rapid attempts, and the cap on them. Whatever removed the
 * chunks may still be writing — a build empties the tree seconds before it has
 * finished replacing it — so re-entering immediately can land on a half-written
 * build. Each attempt waits out more of the write burst.
 */
export const STALE_CHUNK_RELOAD_DELAYS_MS = [600, 2_000, 5_000]

/**
 * How long a scheduled reload may suppress the fallout before we assume the
 * navigation did not take. A window stuck on the "reloading" notice with no way
 * out would be worse than the crash screen it replaced.
 */
export const STALE_CHUNK_RELOAD_GRACE_MS = 10_000

type ReloadBudget = { at: number; attempts: number }

/**
 * A reload is scheduled. In-memory on purpose: it must not outlive the page it
 * belongs to, and the navigation that clears it also reloads this module.
 */
let reloadPending = false

function readBudget(): ReloadBudget | null {
  try {
    const raw = sessionStorage.getItem(STALE_CHUNK_BUDGET_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ReloadBudget>
    if (typeof parsed?.at !== 'number' || typeof parsed?.attempts !== 'number') return null
    return { at: parsed.at, attempts: parsed.attempts }
  } catch {
    // Unavailable or corrupt storage — treat as a fresh budget, never as a block.
    return null
  }
}

function writeBudget(budget: ReloadBudget): void {
  try {
    sessionStorage.setItem(STALE_CHUNK_BUDGET_KEY, JSON.stringify(budget))
  } catch {
    // ignore — a window without storage still gets its reload, just no budget
  }
}

export function isStaleChunkFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : undefined
  if (!message) return false
  const lower = message.toLowerCase()
  return STALE_CHUNK_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * Claim one automatic-reload allowance.
 *
 * @returns the 1-based attempt number, or null while reloads are stacking up
 * inside the cooldown — the signature of a loop rather than a rebuild. Fails
 * open when storage is unavailable.
 */
export function takeStaleChunkReload(now: number = Date.now()): number | null {
  const budget = readBudget()
  const expired = !budget || now - budget.at >= STALE_CHUNK_RELOAD_COOLDOWN_MS
  const attempts = expired ? 1 : budget.attempts + 1
  if (attempts > STALE_CHUNK_RELOAD_DELAYS_MS.length) return null
  writeBudget({ at: now, attempts })
  return attempts
}

/** Re-arm the automatic reload (explicit user-initiated recovery). */
export function rearmStaleChunkReload(): void {
  reloadPending = false
  try {
    sessionStorage.removeItem(STALE_CHUNK_BUDGET_KEY)
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

/**
 * What {@link handleStaleChunkFailure} decided, so a caller can render a calm
 * "reloading" state instead of its crash UI.
 */
export type StaleChunkOutcome = 'not-stale' | 'reloading' | 'exhausted'

/**
 * Classify a renderer failure and, when it is a rebuild artifact, recover.
 *
 * A rebuild is never a crash: neither outcome here may reach `logger.fatal`,
 * which main turns into a crash-history snippet (Settings > crash list) and
 * Sentry ships as a renderer crash.
 */
export function handleStaleChunkFailure(err: unknown): StaleChunkOutcome {
  // Once a reload is on its way, whatever fails before the navigation is a
  // casualty of the same rebuild — a half-loaded surface tearing down, a lazy
  // import that never resolved. None of it is worth reporting as a crash.
  if (reloadPending) return 'reloading'
  if (!isStaleChunkFailure(err)) return 'not-stale'
  return recoverFromStaleChunk()
}

/** As {@link handleStaleChunkFailure}, for a caller that already classified. */
export function recoverFromStaleChunk(): Exclude<StaleChunkOutcome, 'not-stale'> {
  if (reloadPending) return 'reloading'
  const attempt = takeStaleChunkReload()
  if (attempt == null) {
    // A reload just came back to the same failure. Stop, keep it out of the
    // crash paths, and leave the recovery UI up — its Reload button re-arms.
    if (shouldLogErrorSignature('STALE_CHUNK\u0000exhausted').log) {
      logger.warn('Stale renderer chunk persisted after reloading — waiting for the build', {
        scope: 'renderer',
        code: 'STALE_CHUNK'
      })
    }
    return 'exhausted'
  }
  const delayMs = STALE_CHUNK_RELOAD_DELAYS_MS[attempt - 1]
  logger.warn('Stale renderer chunk after rebuild — reloading window', {
    scope: 'renderer',
    code: 'STALE_CHUNK',
    attempt,
    delayMs
  })
  reloadPending = true
  setTimeout(() => {
    reloadWindow()
    setTimeout(() => {
      reloadPending = false
    }, STALE_CHUNK_RELOAD_GRACE_MS)
  }, delayMs)
  return 'reloading'
}
