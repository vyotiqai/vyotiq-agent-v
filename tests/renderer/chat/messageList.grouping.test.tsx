/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import type { UiItem } from '@shared/transcript'
import { toolGroup } from './helpers/testGroups'

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
})

describe('MessageList', () => {
  it('expands and collapses tool groups independently', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u-1', role: 'user', content: 'First task' },
      ...toolGroup('alpha', ['alpha-one.ts', 'alpha-two.ts']),
      { kind: 'message', id: 'u-2', role: 'user', content: 'Second task' },
      ...toolGroup('beta', ['beta-one.ts', 'beta-two.ts'])
    ]

    render(<MessageList items={items} />)

    const toggles = screen.getAllByRole('button', { name: /Read: 2 files/i })
    expect(toggles).toHaveLength(2)
    // Settled groups stay collapsed; expand is opt-in.
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()
    expect(screen.queryByText('beta-one.ts')).toBeNull()

    fireEvent.click(toggles[0]!)

    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false')
    const alphaGroup = toggles[0]!.parentElement as HTMLElement
    expect(within(alphaGroup).getByText('alpha-one.ts')).toBeTruthy()
    expect(within(alphaGroup).getByText('alpha-two.ts')).toBeTruthy()
    expect(screen.queryByText('beta-one.ts')).toBeNull()

    fireEvent.click(toggles[1]!)
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('beta-one.ts')).toBeTruthy()

    fireEvent.click(toggles[0]!)
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => {
      expect(screen.queryByText('alpha-one.ts')).toBeNull()
    })
  })

  it('does not reopen prior-turn tool groups when a follow-up run goes live', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u-1', role: 'user', content: 'First task' },
      ...toolGroup('alpha', ['alpha-one.ts', 'alpha-two.ts']),
      { kind: 'message', id: 'u-2', role: 'user', content: 'continue' }
    ]

    const { rerender } = render(<MessageList items={items} />)
    const prior = screen.getByRole('button', { name: /Read: 2 files/i })
    expect(prior.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()

    rerender(<MessageList items={items} running />)
    expect(prior.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()

    const liveItems: UiItem[] = [
      ...items,
      {
        kind: 'tool',
        id: 'beta-0',
        tool: { id: 'beta-0', name: 'read', summary: 'beta-one.ts', status: 'running' },
        groupTiming: { startedAt: Date.now() }
      },
      {
        kind: 'tool',
        id: 'beta-1',
        tool: { id: 'beta-1', name: 'read', summary: 'beta-two.ts', status: 'running' }
      }
    ]
    rerender(<MessageList items={liveItems} running />)

    // Live expanded turn streams tool chrome inline; prior settled turn stays collapsed.
    const toggles = screen
      .getAllByRole('button', { name: /Read(?:ing)?: 2 files/i })
      .filter((btn) => !/turn work|Collapse turn work/i.test(btn.getAttribute('aria-label') ?? ''))
    expect(toggles).toHaveLength(2)
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText('alpha-one.ts')).toBeNull()
    expect(screen.getByText('beta-one.ts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Collapse turn work$/i })).toBeTruthy()
  })

  it('does not render timestamps in the transcript', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        at: '2026-07-24T15:30:00.000Z'
      }
    ]

    render(<MessageList items={items} />)

    expect(screen.queryByRole('time')).toBeNull()
  })

  it('hides turn work when collapsed but keeps approval cards visible', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u-1', role: 'user', content: 'Edit the file' },
      {
        kind: 'message',
        id: 'a-1',
        role: 'assistant',
        content: '',
        thinking: 'Planning the edit…',
        thinkingStreaming: false
      },
      {
        kind: 'tool',
        id: 'edit-1',
        tool: {
          id: 'edit-1',
          name: 'edit',
          summary: 'src/a.ts',
          status: 'running',
          argsPreview: '{"path":"src/a.ts"}'
        },
        approval: {
          requestId: 'apr-1',
          toolName: 'edit',
          summary: 'src/a.ts',
          argsPreview: '{"path":"src/a.ts"}',
          mutating: true
        },
        groupTiming: { startedAt: 1_000 }
      }
    ]

    render(<MessageList items={items} collapsedTurns={new Set([0])} running />)

    expect(screen.queryByText('Planning the edit…')).toBeNull()
    // Approval card stays interactive while the turn is collapsed.
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Awaiting approval$/i })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Awaiting approval$/i }).getAttribute('aria-expanded')
    ).toBe('false')
  })

  it('hides live expanded activity chrome but keeps approval cards', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u-1', role: 'user', content: 'Edit the file' },
      {
        kind: 'tool',
        id: 'read-1',
        tool: { id: 'read-1', name: 'read', summary: 'src/a.ts', status: 'running' },
        groupTiming: { startedAt: 1_000 }
      },
      {
        kind: 'tool',
        id: 'edit-1',
        tool: {
          id: 'edit-1',
          name: 'edit',
          summary: 'src/a.ts',
          status: 'running',
          argsPreview: '{"path":"src/a.ts"}'
        },
        approval: {
          requestId: 'apr-1',
          toolName: 'edit',
          summary: 'src/a.ts',
          argsPreview: '{"path":"src/a.ts"}',
          mutating: true
        },
        groupTiming: { startedAt: 1_000 }
      }
    ]

    render(<MessageList items={items} running />)

    // Running lookup chrome stays visible; the gated edit is the approval card.
    expect(screen.getByRole('button', { name: /^Reading$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Collapse turn work|Awaiting approval/i })
    ).toBeTruthy()
  })
})
