import { describe, expect, it } from 'vitest'
import {
  MAX_RENDERER_RELOADS,
  RENDERER_RELOAD_COOLDOWN_MS,
  planRendererReload
} from '@main/logging/crashDiagnostics'

describe('planRendererReload', () => {
  it('reloads immediately on the first crash', () => {
    expect(
      planRendererReload({ now: 1_000, lastReloadAt: 0, reloadCount: 0, pending: false })
    ).toEqual({ action: 'reload', waitMs: 0 })
  })

  it('coalesces a second crash into the remaining cooldown', () => {
    const lastReloadAt = 5_000
    const now = lastReloadAt + 1_000
    expect(
      planRendererReload({ now, lastReloadAt, reloadCount: 1, pending: false })
    ).toEqual({ action: 'reload', waitMs: RENDERER_RELOAD_COOLDOWN_MS - 1_000 })
  })

  it('skips while a reload is already pending and gives up at the budget', () => {
    expect(
      planRendererReload({ now: 20_000, lastReloadAt: 10_000, reloadCount: 1, pending: true })
    ).toEqual({ action: 'skip-pending' })
    expect(
      planRendererReload({
        now: 20_000,
        lastReloadAt: 10_000,
        reloadCount: MAX_RENDERER_RELOADS,
        pending: false
      })
    ).toEqual({ action: 'give-up' })
  })
})
