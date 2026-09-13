import { describe, expect, it, vi } from 'vitest'

const openExternalMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('electron', () => ({
  shell: {
    openExternal: openExternalMock
  }
}))

import {
  attachSecurity,
  buildCspPolicy,
  isAllowedHttpsUrl,
  isAllowedPermission,
  needsViteHmrCsp
} from '@main/app/security'

describe('buildCspPolicy', () => {
  it('uses strict production policy without Vite HMR URL', () => {
    const policy = buildCspPolicy({ electronRendererUrl: undefined })
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain('blob:')
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('allows HMR websocket + inline scripts when electron-vite dev URL is set', () => {
    const policy = buildCspPolicy({ electronRendererUrl: 'http://127.0.0.1:5173/' })
    expect(policy).toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).toContain('ws://127.0.0.1:*')
    expect(policy).toContain('blob:')
    expect(policy).not.toContain('unsafe-eval')
  })

  it('needsViteHmrCsp mirrors electronRendererUrl presence', () => {
    expect(needsViteHmrCsp({})).toBe(false)
    expect(needsViteHmrCsp({ electronRendererUrl: 'http://127.0.0.1:5173/' })).toBe(true)
  })
})

describe('isAllowedHttpsUrl', () => {
  it('accepts https and rejects userinfo, http, and malformed URLs', () => {
    expect(isAllowedHttpsUrl('https://example.com/docs')).toBe(true)
    expect(isAllowedHttpsUrl('http://example.com/')).toBe(false)
    expect(isAllowedHttpsUrl('https://user:pass@example.com/')).toBe(false)
    expect(isAllowedHttpsUrl('not a url')).toBe(false)
  })
})

describe('isAllowedPermission', () => {
  it('allows dictation and sanitized clipboard write only', () => {
    expect(isAllowedPermission('media')).toBe(true)
    expect(isAllowedPermission('clipboard-sanitized-write')).toBe(true)
    expect(isAllowedPermission('clipboard-read')).toBe(false)
    expect(isAllowedPermission('notifications')).toBe(false)
    expect(isAllowedPermission('geolocation')).toBe(false)
  })
})

describe('attachSecurity', () => {
  it('opens https links externally and denies in-app window creation', () => {
    openExternalMock.mockClear()
    const handlers: {
      windowOpen?: (detail: { url: string }) => { action: string }
      willNavigate?: (event: { preventDefault: () => void }, url: string) => void
      willRedirect?: (event: { preventDefault: () => void }, url: string) => void
      permission?: (permission: string, callback: (allowed: boolean) => void) => void
      permissionCheck?: (permission: string) => boolean
    } = {}

    const webContents = {
      getURL: () => 'file:///renderer/index.html',
      setWindowOpenHandler: (fn: typeof handlers.windowOpen) => {
        handlers.windowOpen = fn
      },
      on: (event: string, fn: unknown) => {
        if (event === 'will-navigate') handlers.willNavigate = fn as typeof handlers.willNavigate
        if (event === 'will-redirect') handlers.willRedirect = fn as typeof handlers.willRedirect
      },
      session: {
        setPermissionRequestHandler: (
          fn: (wc: unknown, permission: string, callback: (allowed: boolean) => void) => void
        ) => {
          handlers.permission = (permission, callback) => fn(webContents, permission, callback)
        },
        setPermissionCheckHandler: (fn: (wc: unknown, permission: string) => boolean) => {
          handlers.permissionCheck = (permission) => fn(webContents, permission)
        }
      }
    }

    attachSecurity({ webContents } as never)

    const denied = handlers.windowOpen!({ url: 'https://example.com/docs' })
    expect(denied).toEqual({ action: 'deny' })
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/docs')

    openExternalMock.mockRejectedValueOnce(new Error('os launch failed'))
    expect(handlers.windowOpen!({ url: 'https://example.com/other' })).toEqual({ action: 'deny' })

    handlers.windowOpen!({ url: 'http://insecure.example/' })
    expect(openExternalMock).toHaveBeenCalledTimes(2)

    const event = { preventDefault: vi.fn() }
    handlers.willNavigate!(event, 'https://evil.example/')
    expect(event.preventDefault).toHaveBeenCalled()

    const redirectEvent = { preventDefault: vi.fn() }
    handlers.willRedirect!(redirectEvent, 'https://evil.example/redirect')
    expect(redirectEvent.preventDefault).toHaveBeenCalled()

    const denyCb = vi.fn()
    handlers.permission!('notifications', denyCb)
    expect(denyCb).toHaveBeenCalledWith(false)

    const denyBareMedia = vi.fn()
    handlers.permission!('media', denyBareMedia)
    expect(denyBareMedia).toHaveBeenCalledWith(false)

    const allowClipboard = vi.fn()
    handlers.permission!('clipboard-sanitized-write', allowClipboard)
    expect(allowClipboard).toHaveBeenCalledWith(true)

    const denyClipboardRead = vi.fn()
    handlers.permission!('clipboard-read', denyClipboardRead)
    expect(denyClipboardRead).toHaveBeenCalledWith(false)

    const denyCamish = vi.fn()
    handlers.permission!('geolocation', denyCamish)
    expect(denyCamish).toHaveBeenCalledWith(false)

    expect(handlers.permissionCheck!('clipboard-sanitized-write')).toBe(true)
    expect(handlers.permissionCheck!('media')).toBe(true)
    expect(handlers.permissionCheck!('clipboard-read')).toBe(false)
    expect(handlers.permissionCheck!('notifications')).toBe(false)
  })

  it('grants media only for audio on the main renderer', () => {
    openExternalMock.mockReset()
    const handlers: {
      permission?: (
        permission: string,
        callback: (allowed: boolean) => void,
        details?: { mediaTypes?: Array<'audio' | 'video' | 'unknown'> }
      ) => void
    } = {}

    const webContents = {
      getURL: () => 'file:///renderer/index.html',
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      session: {
        setPermissionRequestHandler: (
          fn: (
            wc: unknown,
            permission: string,
            callback: (allowed: boolean) => void,
            details?: { mediaTypes?: Array<'audio' | 'video' | 'unknown'> }
          ) => void
        ) => {
          handlers.permission = (permission, callback, details) =>
            fn(webContents, permission, callback, details)
        },
        setPermissionCheckHandler: () => undefined
      }
    }

    attachSecurity({ webContents } as never)

    const denyBare = vi.fn()
    handlers.permission!('media', denyBare)
    expect(denyBare).toHaveBeenCalledWith(false)

    const allowAudio = vi.fn()
    handlers.permission!('media', allowAudio, { mediaTypes: ['audio'] })
    expect(allowAudio).toHaveBeenCalledWith(true)

    const denyVideo = vi.fn()
    handlers.permission!('media', denyVideo, { mediaTypes: ['video'] })
    expect(denyVideo).toHaveBeenCalledWith(false)

    const denyBoth = vi.fn()
    handlers.permission!('media', denyBoth, { mediaTypes: ['audio', 'video'] })
    expect(denyBoth).toHaveBeenCalledWith(false)
  })
})
