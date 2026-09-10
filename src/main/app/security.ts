import { BrowserWindow, session } from 'electron'
import { shell } from 'electron'
import { logger } from '../../shared/logger'

/** True only for parseable https: URLs (rejects https: with a userinfo/host trick via URL). */
export function isAllowedHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

/** Renderer allow-list: dictation (`media`) + copy buttons (`clipboard-sanitized-write`). */
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write'])

export function isAllowedPermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

function denyOffRendererNavigation(
  event: { preventDefault: () => void },
  url: string,
  current: string
): void {
  if (url !== current) event.preventDefault()
}

export function attachSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedHttpsUrl(url)) {
      void shell.openExternal(url).catch((err) => {
        logger.warn('Failed to open external URL', { scope: 'security', err })
      })
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    denyOffRendererNavigation(event, url, win.webContents.getURL())
  })

  win.webContents.on('will-redirect', (event, url) => {
    denyOffRendererNavigation(event, url, win.webContents.getURL())
  })

  win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = details && 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      const audioOnly = types.length > 0 && types.every((type) => type === 'audio')
      callback(wc === win.webContents && audioOnly)
      return
    }
    callback(isAllowedPermission(permission))
  })

  win.webContents.session.setPermissionCheckHandler((wc, permission) => {
    return wc === win.webContents && isAllowedPermission(permission)
  })
}

/**
 * Keep Chromium's default rejection for bad certificates and record failures.
 * Never calls `callback(true)` — there is no bypass path for invalid certs.
 * Logged with the host only (no URL path/query, no workspace data).
 */
export function applyCertificateLogging(): void {
  const ses = session.defaultSession
  ses.setCertificateVerifyProc((request, callback) => {
    if (request.errorCode !== 0) {
      logger.warn('Certificate verification failed', {
        scope: 'security',
        code: 'CERT_VERIFY',
        url: request.hostname
      })
    }
    // -3 defers to Chromium's default verdict (reject on error).
    callback(-3)
  })
}

/**
 * Loosen CSP only while electron-vite serves the renderer over HTTP (HMR).
 * `is.dev` is true for any unpackaged run (including `pnpm start` / preview),
 * which must NOT get unsafe-eval — that triggers Electron's security warning
 * and is unnecessary without Vite HMR.
 */
export function needsViteHmrCsp(env: { electronRendererUrl?: string } = {}): boolean {
  const url = env.electronRendererUrl ?? process.env.ELECTRON_RENDERER_URL
  return Boolean(url)
}

/** Build Content-Security-Policy header value for the renderer session. */
export function buildCspPolicy(env: { electronRendererUrl?: string } = {}): string {
  if (needsViteHmrCsp(env)) {
    // Vite injects inline module scripts for HMR; avoid unsafe-eval — modern
    // Vite ESM HMR does not require it, and Electron warns when it is present.
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      // `blob:` is a dead directive today: nothing under src/renderer calls
      // URL.createObjectURL (guarded by tests/main/unit/rendererNoObjectUrls.test.ts;
      // audit finding L9 in AUDIT-REPORT-2026-09-10.md). Kept for dev convenience —
      // if the renderer ever adopts object URLs, add `blob:` to the prod policy
      // below too so dev and prod cannot silently diverge.
      "img-src 'self' data: blob:",
      "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:* http://127.0.0.1:* http://localhost:* https:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:* https:"
  ].join('; ')
}

function cspPolicy(): string {
  return buildCspPolicy()
}

export function applyCsp(): void {
  const policy = cspPolicy()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}
