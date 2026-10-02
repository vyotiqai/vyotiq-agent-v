/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApprovalCard } from '@renderer/features/task/record/ApprovalCard'
import { getToasts, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'
import { onOpenSettingsRequest } from '@renderer/app/openSettings'

/** Always allow saves a rule; the app says so once, and where the rule lives. */

beforeEach(() => {
  resetToastStoreForTests()
  window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
})
afterEach(() => {
  cleanup()
  resetToastStoreForTests()
})

const command = {
  requestId: 'req-1',
  toolName: 'terminal',
  summary: 'Run pnpm vitest run',
  argsPreview: JSON.stringify({ command: 'pnpm vitest run' }),
  mutating: true,
  alwaysAllowCommand: 'pnpm vitest'
}

describe('Always allow', () => {
  it('says what it now allows and where, and Settings opens Settings › Agent', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={command} requestedAt={null} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: /^Always allow/ }))
    expect(onDecide).toHaveBeenCalledWith('req-1', 'always')
    await waitFor(() => expect(getToasts()).toHaveLength(1))
    const toast = getToasts()[0]!
    expect(toast.message).toBe('Always allowed pnpm vitest')
    expect(toast.detail).toBe('In this workspace · Settings › Agent')

    const opened: string[] = []
    const stop = onOpenSettingsRequest((section) => opened.push(section))
    toast.action!.onClick()
    stop()
    expect(opened).toEqual(['agent'])
  })

  it('says nothing when the decision did not go through', async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error('Tool approval was not accepted. Try again.'))
    render(<ApprovalCard approval={command} requestedAt={null} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: /^Always allow/ }))
    await screen.findByText('Tool approval was not accepted. Try again.')
    expect(getToasts()).toHaveLength(0)
  })

  it('says nothing for Allow once', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined)
    render(<ApprovalCard approval={command} requestedAt={null} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(onDecide).toHaveBeenCalled())
    await Promise.resolve()
    expect(getToasts()).toHaveLength(0)
  })
})
