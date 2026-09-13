/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
})

describe('MessageList markdown', () => {
  it('renders assistant markdown statically', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '**Bold** and `code`'
      }
    ]

    render(<MessageList items={items} />)
    expect(screen.getByText('Bold')).toBeTruthy()
    expect(screen.getByText('code')).toBeTruthy()
  })

  it('renders user markdown statically', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'u1',
        role: 'user',
        content: '**Bold user** and `code`'
      }
    ]

    render(<MessageList items={items} />)
    expect(screen.getByText('Bold user')).toBeTruthy()
    expect(screen.getByText('code')).toBeTruthy()
  })

  it('balances partial bold while streaming and after complete', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'a2',
        role: 'assistant',
        content: 'Partial **bold',
        streaming: true
      }
    ]

    const { container, rerender } = render(<MessageList items={items} />)
    expect(container.querySelector('.streaming-caret-inline')).toBeNull()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByText('Partial **bold')).toBeNull()

    rerender(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'a2',
            role: 'assistant',
            content: 'Partial **bold',
            streaming: false
          }
        ]}
      />
    )

    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByText('Partial **bold')).toBeNull()
  })
})
