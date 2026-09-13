import { describe, expect, it } from 'vitest'
import {
  COMPOSER_DROPDOWN_TREE_MIN_PX,
  clampComposerDropdownPanel
} from '@renderer/features/chat/components/composer/composerDropdownLayout'

describe('clampComposerDropdownPanel', () => {
  it('clamps width to maxWidth and viewport padding', () => {
    const r = clampComposerDropdownPanel({
      position: { left: 40, top: 400, placement: 'up' },
      maxWidthPx: 360,
      viewportWidth: 800,
      viewportHeight: 600
    })
    expect(r.width).toBe(360)
    expect(r.left).toBe(40)
  })

  it('shrinks width on a narrow viewport', () => {
    const r = clampComposerDropdownPanel({
      position: { left: 0, top: 300, placement: 'up' },
      maxWidthPx: 480,
      viewportWidth: 200,
      viewportHeight: 600
    })
    expect(r.width).toBe(200 - 16)
    expect(r.left).toBe(8)
  })

  it('clamps left so the panel stays inside the viewport', () => {
    const r = clampComposerDropdownPanel({
      position: { left: 700, top: 400, placement: 'up' },
      maxWidthPx: 360,
      viewportWidth: 800,
      viewportHeight: 600
    })
    expect(r.left + r.width).toBeLessThanOrEqual(800 - 8)
    expect(r.left).toBeGreaterThanOrEqual(8)
  })

  it('uses free space above for up placement', () => {
    const r = clampComposerDropdownPanel({
      position: { left: 20, top: 250, placement: 'up' },
      maxWidthPx: 320,
      minHeightPx: 200,
      viewportWidth: 1000,
      viewportHeight: 800
    })
    expect(r.maxHeight).toBe(Math.min(250 - 8, Math.round(800 * 0.7)))
  })

  it('uses free space below for down placement', () => {
    const r = clampComposerDropdownPanel({
      position: { left: 20, top: 100, placement: 'down' },
      maxWidthPx: 320,
      minHeightPx: 200,
      viewportWidth: 1000,
      viewportHeight: 800
    })
    expect(r.maxHeight).toBe(Math.min(800 - 100 - 8, Math.round(800 * 0.7)))
  })

  it('exposes a tree min width suitable for list + path tree', () => {
    expect(COMPOSER_DROPDOWN_TREE_MIN_PX).toBeGreaterThanOrEqual(320)
  })
})
