/**
 * The two seams that let media reach the app window: the privileged-scheme
 * list main registers before `ready` (src/main/video/schemes.ts) and the
 * renderer CSP that must permit it (src/main/app/security.ts).
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  session: {},
  BrowserWindow: class {}
}))

import { buildCspPolicy } from '@main/app/security'
import { MEDIA_SCHEME, RENDER_SCHEME, VIDEO_SCHEMES } from '@main/video/schemes'

describe('VIDEO_SCHEMES', () => {
  it('covers both schemes once each', () => {
    expect(VIDEO_SCHEMES.map((entry) => entry.scheme)).toEqual([RENDER_SCHEME, MEDIA_SCHEME])
  })

  it('marks both standard, secure, fetch-capable and streamable', () => {
    for (const entry of VIDEO_SCHEMES) {
      expect(entry.privileges, entry.scheme).toMatchObject({
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      })
    }
    // WebCodecs needs a secure context on the render page.
    expect(RENDER_SCHEME).toBe('vyotiq-render')
    expect(MEDIA_SCHEME).toBe('vyotiq-media')
  })
})

describe('buildCspPolicy media-src', () => {
  it('allows the media scheme in the production policy', () => {
    const policy = buildCspPolicy({ electronRendererUrl: undefined })
    expect(policy).toContain(`media-src 'self' ${MEDIA_SCHEME}:`)
  })

  it('keeps dev and prod in step on media-src', () => {
    const dev = buildCspPolicy({ electronRendererUrl: 'http://127.0.0.1:5173/' })
    expect(dev).toContain(`media-src 'self' ${MEDIA_SCHEME}:`)
  })

  it('does not widen media-src with blob: or data:', () => {
    const policy = buildCspPolicy({ electronRendererUrl: undefined })
    const mediaSrc = /media-src([^;]*)/.exec(policy)?.[1] ?? ''
    expect(mediaSrc).not.toContain('blob:')
    expect(mediaSrc).not.toContain('data:')
    expect(mediaSrc).not.toContain('*')
  })
})