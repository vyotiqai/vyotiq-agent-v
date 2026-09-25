import { describe, expect, it } from 'vitest'
import {
  clampDockWidthPx,
  clampSidebarWidthPx,
  DOCK_WIDTH_DEFAULT_PX,
  DOCK_WIDTH_MIN_PX,
  paneCapacityReservedPx
} from '@renderer/lib/utils/layout'

describe('clampSidebarWidthPx', () => {
  it('respects absolute min/max on a wide viewport', () => {
    expect(clampSidebarWidthPx(100, 1600)).toBe(220)
    expect(clampSidebarWidthPx(500, 1600)).toBe(420)
    expect(clampSidebarWidthPx(220, 1600)).toBe(220)
  })

  it('shrinks with the viewport so a usable chat column remains', () => {
    // 500 viewport − 280 chat min = 220 → clamp max becomes 220
    expect(clampSidebarWidthPx(420, 500)).toBe(220)
    // 700 − 280 = 420 → clamp max becomes 420
    expect(clampSidebarWidthPx(420, 700)).toBe(420)
  })
})

describe('clampDockWidthPx', () => {
  it('respects absolute min/max on a wide viewport', () => {
    expect(clampDockWidthPx(100, 1600)).toBe(DOCK_WIDTH_MIN_PX)
    expect(clampDockWidthPx(1200, 1600)).toBe(960)
    expect(clampDockWidthPx(DOCK_WIDTH_DEFAULT_PX, 1600)).toBe(DOCK_WIDTH_DEFAULT_PX)
  })

  it('reserves sidebar floor + chat min so three-pane stays usable', () => {
    // 1000 − 280 chat − 220 navigator = 500 → width wins
    expect(clampDockWidthPx(480, 1000)).toBe(480)
    expect(clampDockWidthPx(DOCK_WIDTH_DEFAULT_PX, 1000)).toBe(DOCK_WIDTH_DEFAULT_PX)
    // 700 − 280 − 220 = 200, but floor is DOCK_WIDTH_MIN_PX (280)
    expect(clampDockWidthPx(400, 700)).toBe(DOCK_WIDTH_MIN_PX)
  })

  it('opens at the redesign width beside the navigator in a 1440px window', () => {
    // 1440 − 264 navigator − 452 inspector leaves a 724px record.
    expect(DOCK_WIDTH_DEFAULT_PX).toBe(452)
    expect(clampDockWidthPx(DOCK_WIDTH_DEFAULT_PX, 1440, { sidebarWidthPx: 264 })).toBe(452)
  })

  it('reserves two chat columns when paneCount is 2', () => {
    // 1600 − 2×280 − 180 sidebar = 860 → width wins
    expect(clampDockWidthPx(800, 1600, { paneCount: 2, sidebarWidthPx: 180 })).toBe(800)
  })
})

describe('paneCapacityReservedPx', () => {
  it('sums the sidebar and the inspector while it is shown', () => {
    expect(
      paneCapacityReservedPx({ sidebarWidthPx: 200, dockOpen: true, dockWidthPx: 400 })
    ).toBe(600)
    // Hidden, the inspector leaves nothing behind — there is no rail any more.
    expect(paneCapacityReservedPx({ sidebarWidthPx: 200, dockOpen: false, dockWidthPx: 400 })).toBe(
      200
    )
  })
})
