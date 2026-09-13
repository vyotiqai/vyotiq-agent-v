/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ThinkingBlock } from '@renderer/features/chat/components/ThinkingBlock'

afterEach(() => {
  cleanup()
})

describe('ThinkingBlock', () => {
  it('keeps finished thought collapsed by default (minimal chrome)', () => {
    render(<ThinkingBlock content="Let me reason about this." />)
    const button = screen.getByRole('button', { name: /thought/i })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('thinking-body')).toBeNull()

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Let me reason about this.')).toBeTruthy()
  })

  it('opens while streaming so live reasoning is visible', () => {
    render(<ThinkingBlock content="Let me reason about this." streaming />)
    const button = screen.getByRole('button', { name: /thinking/i })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Let me reason about this.')).toBeTruthy()
  })

  it('lets the reader close the reasoning mid-stream', async () => {
    render(<ThinkingBlock content="Let me reason about this." streaming />)
    fireEvent.click(screen.getByRole('button', { name: /thinking/i }))
    await waitFor(() => {
      expect(screen.queryByText('Let me reason about this.')).toBeNull()
    })
  })

  it('honours an explicit expanded state over the stream', () => {
    render(<ThinkingBlock content="Let me reason about this." streaming expanded={false} />)
    expect(screen.queryByText('Let me reason about this.')).toBeNull()
  })

  it('renders placeholder-only reasoning when mounted directly (MessageList filters rows)', () => {
    render(<ThinkingBlock content="." />)
    expect(screen.getByRole('button', { name: /thought/i })).toBeTruthy()
  })

  it('renders short finished reasoning when mounted directly (MessageList filters rows)', () => {
    render(<ThinkingBlock content="OK" />)
    expect(screen.getByRole('button', { name: /thought: ok/i })).toBeTruthy()
    expect(screen.queryByTestId('thinking-preview')).toBeNull()
  })

  it('keeps finished-thought preview in the accessible name, not the row', () => {
    render(<ThinkingBlock content={'\n\nFirst useful step.\nSecond step.'} />)
    expect(screen.getByRole('button', { name: /thought: first useful step\./i })).toBeTruthy()
    expect(screen.queryByTestId('thinking-preview')).toBeNull()
  })

  it('does not show a truncated preview fragment while the finished thought is open', () => {
    render(<ThinkingBlock content="First useful step." expanded />)
    expect(screen.queryByTestId('thinking-preview')).toBeNull()
  })

  it('still shows short reasoning while it streams', () => {
    render(<ThinkingBlock content="OK" streaming />)
    expect(screen.getByRole('button', { name: /thinking/i })).toBeTruthy()
  })

  it('caps open reasoning in a scrollable body so it cannot flood the timeline', () => {
    const long = 'Plan step. '.repeat(80)
    const { container } = render(<ThinkingBlock content={long} streaming />)
    const body = container.querySelector('.overflow-y-auto')
    expect(body).toBeTruthy()
    expect(body?.className).toMatch(/max-h-\[min\(/)
  })

  it('forces muted ink on streaming reasoning body', () => {
    const { container } = render(<ThinkingBlock content="Let me reason about this." streaming />)
    const body = container.querySelector('.overflow-y-auto .markdown-body')
    // THINKING_INK uses text-secondary (readable but dimmer than answer text-fg).
    expect(body?.className).toMatch(/text-secondary/)
    expect(body?.className).toMatch(/text-sm/)
  })

  it('uses markdown when expanded after streaming', () => {
    const { container } = render(<ThinkingBlock content="Let me reason about this." expanded />)
    expect(container.querySelector('.markdown-body')).toBeTruthy()
  })

  it('shimmers the Thinking label while streaming, like other running verbs', () => {
    const { container } = render(<ThinkingBlock content="Working through it." streaming />)
    const shimmer = container.querySelector('.vy-text-shimmer--active')
    expect(shimmer?.textContent).toBe('Thinking')

    const { container: doneContainer } = render(<ThinkingBlock content="Working through it." />)
    expect(doneContainer.querySelector('.vy-text-shimmer--active')).toBeNull()
    expect(doneContainer.textContent).toContain('Thought')
  })

  it('stops following the stream once the reader scrolls away from the bottom', () => {
    const base = 'Plan step. '.repeat(40)
    const { container, rerender } = render(<ThinkingBlock content={base} streaming />)
    const body = container.querySelector('[data-testid="thinking-body"]') as HTMLElement
    expect(body).toBeTruthy()
    Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 300, configurable: true })

    // Reader scrolls up: pin releases, and further stream growth must not yank.
    body.scrollTop = 100
    fireEvent.scroll(body)
    rerender(<ThinkingBlock content={`${base}More reasoning.`} streaming />)
    expect(body.scrollTop).toBe(100)

    // Reader returns to the bottom: follow resumes.
    body.scrollTop = 700
    fireEvent.scroll(body)
    rerender(<ThinkingBlock content={`${base}More reasoning. Even more.`} streaming />)
    expect(body.scrollTop).toBe(1000)
  })

  it('labels every thought plain "Thought" without numbering steps in a chain', () => {
    const { container } = render(<ThinkingBlock content="first step" />)
    expect(container.textContent).toMatch(/Thought/)
    expect(container.textContent).not.toMatch(/Thought \d/)
    const second = render(<ThinkingBlock content="second step" />)
    expect(second.container.textContent).toMatch(/Thought/)
    expect(second.container.textContent).not.toMatch(/Thought \d/)
    const third = render(<ThinkingBlock content="third step" />)
    expect(third.container.textContent).toMatch(/Thought/)
    expect(third.container.textContent).not.toMatch(/Thought \d/)
  })

  it('reserves the overlay-scrollbar gutter in the scrollable body', () => {
    const long = 'Plan step. '.repeat(80)
    const { container } = render(<ThinkingBlock content={long} streaming />)
    const body = container.querySelector('[data-testid="thinking-body"]') as HTMLElement
    expect(body.className).toMatch(/pr-2\.5/)
  })
})
