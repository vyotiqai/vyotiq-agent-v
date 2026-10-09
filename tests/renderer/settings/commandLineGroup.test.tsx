/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CliPathStatus } from '@shared/ipc'
import { CommandLineGroup } from '@renderer/features/settings/components/CommandLineGroup'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'vyotiq')
})

function bridge(status: CliPathStatus) {
  const cliPathStatus = vi.fn(async () => ({ ok: true as const, data: status }))
  const cliPathSet = vi.fn(async ({ onPath }: { onPath: boolean }) => ({
    ok: true as const,
    data: { ...status, onPath }
  }))
  Object.defineProperty(window, 'vyotiq', { value: { cliPathStatus, cliPathSet }, configurable: true })
  return { cliPathStatus, cliPathSet }
}

describe('Settings › Command line', () => {
  it('adds vyotiq to PATH, then offers to take it off', async () => {
    const api = bridge({ available: true, onPath: false, dir: 'C:\\Agent V\\resources\\cli' })
    render(<CommandLineGroup disabled={false} onError={vi.fn()} />)
    const add = await screen.findByRole('button', { name: 'Add to PATH' })
    fireEvent.click(add)
    await screen.findByRole('button', { name: 'Remove from PATH' })
    expect(api.cliPathSet).toHaveBeenCalledWith({ onPath: true })
    expect(screen.getByText(/On your PATH, for terminals opened from now on/)).toBeTruthy()
    expect(api.cliPathStatus).toHaveBeenCalledTimes(1)
  })

  it('says why a build that isn’t installed can’t', async () => {
    bridge({ available: false, onPath: false, dir: null })
    render(<CommandLineGroup disabled={false} onError={vi.fn()} />)
    await screen.findByText('Only an installed Agent V can put itself on your PATH.')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Add to PATH' }) as HTMLButtonElement).disabled).toBe(true)
    )
  })

  it('passes a failure on', async () => {
    const onError = vi.fn()
    Object.defineProperty(window, 'vyotiq', {
      value: { cliPathStatus: vi.fn(async () => ({ ok: false as const, error: 'PowerShell is missing' })) },
      configurable: true
    })
    render(<CommandLineGroup disabled={false} onError={onError} />)
    await waitFor(() => expect(onError).toHaveBeenCalledWith('PowerShell is missing'))
  })
})
