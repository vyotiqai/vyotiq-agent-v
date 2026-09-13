import { describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent } from 'react'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    preventDefault: vi.fn()
  } as unknown as KeyboardEvent
}

describe('handleTabListKeyDown', () => {
  it('moves from an activeId outside tabs to the first/last panel', () => {
    const onSelect = vi.fn()
    const tabs = ['terminal', 'browser']

    handleTabListKeyDown(keyEvent('ArrowRight'), {
      tabs,
      activeId: 'agent',
      onSelect
    })
    expect(onSelect).toHaveBeenCalledWith('terminal')

    onSelect.mockClear()
    handleTabListKeyDown(keyEvent('ArrowLeft'), {
      tabs,
      activeId: 'agent',
      onSelect
    })
    expect(onSelect).toHaveBeenCalledWith('browser')
  })

  it('wraps within tabs when activeId is present', () => {
    const onSelect = vi.fn()
    const tabs = ['terminal', 'browser', 'files']

    handleTabListKeyDown(keyEvent('ArrowRight'), {
      tabs,
      activeId: 'files',
      onSelect
    })
    expect(onSelect).toHaveBeenCalledWith('terminal')
  })
})
