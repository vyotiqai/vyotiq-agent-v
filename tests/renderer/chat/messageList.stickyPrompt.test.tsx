/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const items: UiItem[] = [
  { kind: 'message', id: 'u1', role: 'user', content: 'first ask' },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'first reply' },
  { kind: 'message', id: 'u2', role: 'user', content: 'second ask\nwith detail' },
  { kind: 'message', id: 'a2', role: 'assistant', content: 'second reply' }
]

describe('MessageList native turn prompt pinning', () => {
  it('marks the original user prompt bubble as the pinned element without complete row fills', () => {
    render(<MessageList items={items} />)
    const pinned = [...document.querySelectorAll('[data-sticky-turn-prompt]')]
    expect(pinned.length).toBe(2)
    for (const el of pinned) {
      // The prompt bubble pins inline (position: sticky) without full-row bg-bg fills
      expect(el.className).toContain('sticky')
      expect(el.className).not.toContain('bg-bg')
      const prompt = el.querySelector('[data-user-prompt]')
      expect(prompt).not.toBeNull()
      // Edge-to-edge floating bubble styling with surface shadow
      expect(prompt!.className).toContain('w-full')
      expect(prompt!.className).toContain('shadow-[var(--vy-shadow-chrome)]')
    }
  })

  it('wraps each turn so prompts release at turn boundaries', () => {
    render(<MessageList items={items} />)
    const groups = [...document.querySelectorAll('[data-turn-group]')]
    expect(groups.length).toBe(2)
    expect(groups[0]!.querySelector('[data-sticky-turn-prompt]')!.textContent).toContain(
      'first ask'
    )
    expect(groups[1]!.querySelector('[data-sticky-turn-prompt]')!.textContent).toContain(
      'second ask'
    )
  })

  it('renders each prompt exactly once — no duplicate floating header', () => {
    render(<MessageList items={items} />)
    const text = document.body.textContent ?? ''
    expect(text.split('first ask').length - 1).toBe(1)
    expect(text.split('second ask').length - 1).toBe(1)
    // The old external pin marker stays absent.
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()
  })
})
