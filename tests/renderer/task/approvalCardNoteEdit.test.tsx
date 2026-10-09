/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApprovalCard } from '@renderer/features/task/record/ApprovalCard'

afterEach(() => {
  cleanup()
  window.vyotiq = undefined as unknown as typeof window.vyotiq
})

const edit = { requestId: 'req-1', toolName: 'edit', summary: 'a.ts', argsPreview: '{"path":"a.ts"}', mutating: true }
const command = {
  requestId: 'req-2',
  toolName: 'terminal',
  summary: 'pnpm test',
  argsPreview: '{"command":"pnpm test --all"}',
  mutating: true,
  alwaysAllowCommand: 'pnpm test'
}

describe('ApprovalCard — a note with Deny', () => {
  it('sends what to do instead with the deny', async () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn()
    render(<ApprovalCard approval={edit} requestedAt={null} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny with a note…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'What to do instead' }), {
      target: { value: 'Edit b.ts instead' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Deny and send' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('req-1', 'deny', { note: 'Edit b.ts instead' }))
  })

  it('a plain Deny stays one press with nothing extra', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn()
    render(<ApprovalCard approval={edit} requestedAt={null} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onDecide).toHaveBeenCalledWith('req-1', 'deny')
  })
})

describe('ApprovalCard — edit a command', () => {
  it('runs the edited command once', async () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn()
    render(<ApprovalCard approval={command} requestedAt={null} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Command to run' }), {
      target: { value: 'pnpm test src/a.test.ts' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run edited once' }))
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith('req-2', 'once', { editedCommand: 'pnpm test src/a.test.ts' })
    )
  })

  it('offers no edit for a command the guard stopped, or for a file change', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const view = render(
      <ApprovalCard approval={{ ...command, danger: 'Deletes outside the workspace' }} requestedAt={null} onDecide={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    view.unmount()
    render(<ApprovalCard approval={edit} requestedAt={null} onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})

describe('ApprovalCard — the wait', () => {
  it('counts down from the request’s own timeout, and says nothing when it has none', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const now = Date.now()
    const view = render(<ApprovalCard approval={{ ...edit, timeoutMs: 5 * 60_000 }} requestedAt={now} onDecide={vi.fn()} />)
    expect(document.body.textContent).toContain('denied automatically in 5 min')
    view.unmount()
    render(<ApprovalCard approval={{ ...edit, timeoutMs: null }} requestedAt={now} onDecide={vi.fn()} />)
    expect(document.body.textContent).not.toContain('denied automatically')
  })
})
