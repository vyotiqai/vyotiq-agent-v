/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RepoCommandsNotice } from '@renderer/features/chat/components/RepoCommandsNotice'

const repoCommands = {
  blocked: [
    { key: 'core.fsmonitor', value: 'sh .git/hooks/watch' },
    { key: 'filter.crypt.clean', value: '"/usr/bin/git-crypt" clean' }
  ],
  canAllow: true
}

function stubAllow(result: { ok: true; data: { allowed: number } } | { ok: false; error: string }) {
  const gitAllowRepoCommands = vi.fn(async () => result)
  ;(window as unknown as { vyotiq: unknown }).vyotiq = { gitAllowRepoCommands }
  return gitAllowRepoCommands
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

describe('RepoCommandsNotice', () => {
  it('lists each skipped setting as the repository wrote it', () => {
    stubAllow({ ok: true, data: { allowed: 2 } })
    render(<RepoCommandsNotice workspacePath="/w" repoCommands={repoCommands} inset="px-3" onAllowed={() => {}} />)
    expect(screen.getByRole('status').textContent).toContain("Vyotiq's git skips them")
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual(['core.fsmonitorsh .git/hooks/watch', 'filter.crypt.clean"/usr/bin/git-crypt" clean'])
  })

  it('allows only after the person confirms, then refreshes', async () => {
    const allow = stubAllow({ ok: true, data: { allowed: 2 } })
    const onAllowed = vi.fn()
    render(<RepoCommandsNotice workspacePath="/w" repoCommands={repoCommands} inset="px-3" onAllowed={onAllowed} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow for this repo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Allow for this repository' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
    await waitFor(() => expect(dialog.isConnected).toBe(false))
    expect(allow).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Allow for this repo' }))
    await screen.findByRole('dialog', { name: 'Allow for this repository' })
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(onAllowed).toHaveBeenCalledTimes(1))
    expect(allow).toHaveBeenCalledWith({ workspacePath: '/w' })
  })

  it('shows why an allowance failed, with an icon, not only in red', async () => {
    stubAllow({ ok: false, error: 'Could not tell which repository this is, so nothing was allowed.' })
    render(<RepoCommandsNotice workspacePath="/w" repoCommands={repoCommands} inset="px-3" onAllowed={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this repo' }))
    await screen.findByRole('dialog', { name: 'Allow for this repository' })
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('nothing was allowed')
    expect(alert.querySelector('svg')).not.toBeNull()
  })

  it('offers no allowance when the repository cannot be told apart', () => {
    stubAllow({ ok: true, data: { allowed: 0 } })
    render(
      <RepoCommandsNotice
        workspacePath="/w"
        repoCommands={{ ...repoCommands, canAllow: false }}
        inset="px-4"
        onAllowed={() => {}}
      />
    )
    expect(screen.queryByRole('button', { name: 'Allow for this repo' })).toBeNull()
  })
})
