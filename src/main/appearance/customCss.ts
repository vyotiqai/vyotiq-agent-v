import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { getMainWindow } from '@main/app/window'
import { getSettings } from '@main/settings/settings'
import { IPC } from '@shared/channels'

export const CUSTOM_CSS_MAX_BYTES = 256 * 1024

let watcher: FSWatcher | null = null
let watchedPath = ''
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** Strip remote @import so user CSS cannot pull http(s) styles or fonts. */
export function sanitizeCustomCss(raw: string): string {
  return raw.replace(/@import\s+(?:url\s*\(\s*)?['"]?https?:[^;]+;?/gi, '')
}

export function readCustomCssFromPath(path: string): { ok: true; css: string } | { ok: false; error: string } {
  if (!path.trim()) return { ok: true, css: '' }
  try {
    const buf = readFileSync(path)
    if (buf.byteLength > CUSTOM_CSS_MAX_BYTES) {
      return { ok: false, error: 'CSS file exceeds 256KB limit' }
    }
    return { ok: true, css: sanitizeCustomCss(buf.toString('utf8')) }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read CSS file'
    return { ok: false, error: message }
  }
}

function pushCustomCssChanged(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.appearanceCustomCssChanged, { path: watchedPath })
}

/** Notify renderer to reload overlay CSS from disk (path change or external edit). */
export function notifyCustomCssChanged(): void {
  pushCustomCssChanged()
}

export function stopCustomCssWatch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
  }
  watchedPath = ''
}

export function syncCustomCssWatch(path: string): void {
  stopCustomCssWatch()
  const trimmed = path.trim()
  if (!trimmed) return
  watchedPath = trimmed
  try {
    watcher = watch(trimmed, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => pushCustomCssChanged(), 300)
    })
  } catch {
    watchedPath = ''
  }
}

export function initCustomCssWatchFromSettings(): void {
  syncCustomCssWatch(getSettings().customCssPath)
}

export function readCustomCssForSettings(): { ok: true; css: string } | { ok: false; error: string } {
  return readCustomCssFromPath(getSettings().customCssPath)
}
