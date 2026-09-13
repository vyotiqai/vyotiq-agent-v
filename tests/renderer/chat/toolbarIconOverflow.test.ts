import { describe, expect, it } from 'vitest'
import { toolbarVisibleIconCount } from '@renderer/features/chat/components/useToolbarIconOverflow'

describe('toolbarVisibleIconCount', () => {
  it('fits every icon when the strip is wide enough', () => {
    expect(toolbarVisibleIconCount(400, 6)).toBe(6)
  })

  it('reserves one slot for overflow when space is tight', () => {
    expect(toolbarVisibleIconCount(120, 6)).toBe(3)
    expect(toolbarVisibleIconCount(40, 6)).toBe(0)
  })

  it('returns zero for empty toolbars', () => {
    expect(toolbarVisibleIconCount(200, 0)).toBe(0)
  })
})
