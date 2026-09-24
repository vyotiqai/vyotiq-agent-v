/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard } from '@renderer/features/task/record/ApprovalCard'

afterEach(() => {
  cleanup()
  window.vyotiq = undefined as unknown as typeof window.vyotiq
})

const approval = {
  requestId: 'req-1',
  toolName: 'edit',
  summary: 'a.ts',
  argsPreview: '{"path":"a.ts"}',
  mutating: true
}

describe('ApprovalCard keys', () => {
  it('allows with Alt A and denies with Alt D, by the physical key — Option+A types "å" on macOS', () => {
    window.vyotiq = { platform: 'darwin' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn()
    const view = render(<ApprovalCard approval={approval} requestedAt={null} onDecide={onDecide} />)
    // The label a macOS reader sees.
    expect(screen.getByRole('button', { name: 'Allow once' }).getAttribute('title')).toBe('Allow once (⌥A)')
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', altKey: true })
    expect(onDecide).toHaveBeenCalledWith('req-1', 'once')

    view.unmount()
    const onDeny = vi.fn()
    render(<ApprovalCard approval={{ ...approval, requestId: 'req-2' }} requestedAt={null} onDecide={onDeny} />)
    fireEvent.keyDown(window, { key: '∂', code: 'KeyD', altKey: true })
    expect(onDeny).toHaveBeenCalledWith('req-2', 'deny')
  })

  it('says Alt+A on Windows and Linux', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    render(<ApprovalCard approval={approval} requestedAt={null} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Allow once' }).getAttribute('title')).toBe('Allow once (Alt+A)')
  })
})
