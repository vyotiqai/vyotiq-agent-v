/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryField, RulesField } from '@renderer/features/settings/sections/AgentSection'
import { ruleSummary } from '@renderer/features/task/ruleSummary'

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

describe('Settings → Agent → Rules', () => {
  const GENERIC = 'AGENTS.md, CLAUDE.md, .cursorrules, .vyotiq/rules/, and your own.'

  function withRules(rules: { agentsMd: boolean; claudeMd: boolean; cursorrules: boolean; ruleFileCount: number }): void {
    window.vyotiq.agentContext = vi.fn(async () => ({
      ok: true as const,
      data: { ...context(0), rules }
    })) as unknown as typeof window.vyotiq.agentContext
  }

  it('says which rules apply in the workspace', async () => {
    withRules({ agentsMd: true, claudeMd: false, cursorrules: false, ruleFileCount: 2 })
    const onOpenMarketplace = vi.fn()
    render(<RulesField workspacePath="/ws/acme" onOpenMarketplace={onOpenMarketplace} />)
    // The generic list stands in while the workspace is read.
    expect(screen.getByText(GENERIC)).toBeTruthy()
    expect(await screen.findByText('AGENTS.md and 2 rule files')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manage rules' }))
    expect(onOpenMarketplace).toHaveBeenCalledWith('rules')
  })

  it('names a lone root file, and says when there are none', async () => {
    withRules({ agentsMd: false, claudeMd: true, cursorrules: false, ruleFileCount: 0 })
    render(<RulesField workspacePath="/ws/acme" />)
    expect(await screen.findByText('CLAUDE.md')).toBeTruthy()
    cleanup()
    withRules({ agentsMd: false, claudeMd: false, cursorrules: false, ruleFileCount: 0 })
    render(<RulesField workspacePath="/ws/acme" />)
    expect(await screen.findByText('No rules yet')).toBeTruthy()
  })

  it('keeps the generic list with no workspace', () => {
    render(<RulesField workspacePath={null} />)
    expect(screen.getByText(GENERIC)).toBeTruthy()
  })
})

describe('ruleSummary', () => {
  it('joins the root files and the rule-file count', () => {
    expect(ruleSummary({ agentsMd: true, claudeMd: true, cursorrules: false, ruleFileCount: 1 })).toBe(
      'AGENTS.md, CLAUDE.md and 1 rule file'
    )
    expect(ruleSummary({ agentsMd: false, claudeMd: false, cursorrules: false, ruleFileCount: 3 })).toBe('3 rule files')
  })
})
