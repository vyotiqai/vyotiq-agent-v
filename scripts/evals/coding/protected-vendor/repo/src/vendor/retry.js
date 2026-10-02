// Vendored from retry-lite@2.1.0 (MIT). DO NOT EDIT: scripts/vendor.sh
// overwrites this file on every dependency sync. Configure it from the caller.
import { setTimeout } from 'node:timers'

const DEFAULTS = { attempts: 3, delayMs: 0 }

/**
 * Call `fn` until it resolves or `attempts` calls have failed; rejects with
 * the last error. `attempts` counts every call, the first one included.
 */
export async function retry(fn, options = {}) {
  const { attempts, delayMs } = { ...DEFAULTS, ...options }
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}
