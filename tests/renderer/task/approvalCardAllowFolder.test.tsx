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

const base = {
  requestId: 'req-1',
  toolName: 'str_replace',
  summary: 'src/lib/a.ts',
  mutating: true,
  argsPreview: '{"path":"src/lib/a.ts"}'
}

describe('ApprovalCard — always allow edits under a folder', () => {
  it('offers the folder beside the tool-wide Always, and sends allowFolder', async () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn(async () => {})
    render(<ApprovalCard approval={{ ...base, alwaysAllowFolder: 'src' }} requestedAt={null} onDecide={onDecide} />)
    const folder = screen.getByRole('button', { name: /Always allow edits under src\// })
    expect(screen.getByRole('button', { name: /Always allow str_replace/ })).toBeTruthy()
    fireEvent.click(folder)
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('req-1', 'always', { allowFolder: true }))
  })

  it('has no folder button for a root file or a guarded call', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const { rerender } = render(<ApprovalCard approval={base} requestedAt={null} onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /edits under/ })).toBeNull()
    rerender(
      <ApprovalCard
        approval={{ ...base, alwaysAllowFolder: 'src', danger: 'Touches a protected path' }}
        requestedAt={null}
        onDecide={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /edits under/ })).toBeNull()
  })
})
