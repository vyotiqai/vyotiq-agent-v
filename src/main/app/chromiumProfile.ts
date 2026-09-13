import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

function appVersionTag(): string {
  try {
    return app.getVersion()
  } catch {
    return '0'
  }
}

/** Fingerprint the packaged main bundle so rebuilds do not reuse stale Chromium disk cache. */
export function buildCacheFingerprint(mainBundlePath: string): string {
  const version = appVersionTag()
  try {
    if (existsSync(mainBundlePath)) {
      const stat = statSync(mainBundlePath)
      return createHash('sha256')
        .update(`${version}:${stat.mtimeMs}:${stat.size}`)
        .digest('hex')
        .slice(0, 12)
    }
  } catch {
    // ignore — fall back to version-only
  }
  return version.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Isolate Chromium disk cache per build fingerprint.
 * Prevents renderer crashes from stale GPU/disk cache after `pnpm build`.
 */
export function configureChromiumDiskCache(mainBundlePath: string): string {
  const userData = app.getPath('userData')
  const fingerprint = buildCacheFingerprint(mainBundlePath)
  const cacheDir = join(userData, 'Cache', fingerprint)
  mkdirSync(cacheDir, { recursive: true })
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir)
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

  const markerPath = join(userData, 'chromium-cache-fingerprint')
  const prev = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : ''
  if (prev && prev !== fingerprint) {
    try {
      writeFileSync(markerPath, fingerprint, 'utf8')
    } catch {
      // non-fatal
    }
  } else if (!prev) {
    try {
      writeFileSync(markerPath, fingerprint, 'utf8')
    } catch {
      // non-fatal
    }
  }
  return cacheDir
}
