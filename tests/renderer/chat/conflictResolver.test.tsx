/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConflictResolver } from '@renderer/features/chat/components/ConflictResolver'

afterEach(() => {
  cleanup()
  ;(window as unknown as { vyotiq?: unknown }).vyotiq = undefined
})

describe('ConflictResolver', () => {
  it('saves the working copy only once it has loaded, never an empty one', async () => {
    let load!: (value: unknown) => void
    const gitConflictFile = vi.fn(() => new Promise((resolve) => (load = resolve)))
    const gitResolveConflict = vi.fn(async () => ({ ok: true as const }))
    ;(window as unknown as { vyotiq: unknown }).vyotiq = { gitConflictFile, gitResolveConflict }
    render(<ConflictResolver workspacePath="C:/ws" path="a.ts" onResolved={vi.fn()} onError={vi.fn()} />)

    const save = screen.getByRole('button', { name: 'Save working' })
    expect(save).toHaveProperty('disabled', true)
    fireEvent.click(save)
    expect(gitResolveConflict).not.toHaveBeenCalled()

    load({ ok: true, data: { ours: 'o', theirs: 't', base: 'b', working: 'merged' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save working' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('button', { name: 'Save working' }))
    expect(gitResolveConflict).toHaveBeenCalledWith({ workspacePath: 'C:/ws', path: 'a.ts', content: 'merged' })
  })
})
