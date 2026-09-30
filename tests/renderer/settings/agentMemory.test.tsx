/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryField } from '@renderer/features/settings/sections/AgentSection'

const context = (memoryNotes: number) => ({
  workspaceName: 'acme',
  branch: 'main',
  rules: { agentsMd: false, claudeMd: false, cursorrules: false, ruleFileCount: 0 },
  memoryNotes,
  memoryIndex: memoryNotes > 0,
  memoryState: false,
  codeIndex: { state: 'off' as const }
})

let notes = 12
let clearWorkspaceMemory: ReturnType<typeof vi.fn>

beforeEach(() => {
  notes = 12
  clearWorkspaceMemory = vi.fn(async () => {
    const cleared = notes
    notes = 0
    return { ok: true as const, data: { notes: cleared } }
  })
  window.vyotiq = {
    agentContext: vi.fn(async () => ({ ok: true as const, data: context(notes) })),
    onAgentContextChanged: vi.fn(() => () => {}),
    clearWorkspaceMemory
  } as unknown as typeof window.vyotiq
})

afterEach(() => cleanup())

describe('Settings → Agent → Memory', () => {
  it('shows the count, and clears only after the confirm', async () => {
    render(<MemoryField workspacePath="/ws/acme" />)
    expect(await screen.findByText('12 notes earlier tasks wrote about acme.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Clear memory?' })
    expect(dialog.textContent).toContain('can’t be undone')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(clearWorkspaceMemory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Clear…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear memory' }))
    await waitFor(() => expect(clearWorkspaceMemory).toHaveBeenCalledWith({ workspacePath: '/ws/acme' }))
    expect(await screen.findByText('None yet for acme.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Clear…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has nothing to clear without a workspace', () => {
    render(<MemoryField workspacePath={null} />)
    expect(screen.getByText('No workspace is open.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Clear…' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
