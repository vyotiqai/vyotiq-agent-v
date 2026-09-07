/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AgentContextCard } from '@renderer/features/chat/components/AgentContextCard'

const fixture = {
  workspaceName: 'demo-workspace',
  branch: 'main',
  rules: { agentsMd: true, cursorrules: true, vyotiqRulesCount: 2 },
  memoryNotes: 3,
  codeIndex: { state: 'ready' as const }
}

let agentContextSpy: Mock

describe('AgentContextCard', () => {
  beforeEach(() => {
    agentContextSpy = vi.fn()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { agentContext: agentContextSpy }
    })
  })

  afterEach(cleanup)

  it('renders all segments with real values via the bridge', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await waitFor(() => {
      expect(screen.getByText('demo-workspace')).toBeTruthy()
    })
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('AGENTS.md')).toBeTruthy()
    expect(screen.getByText('.cursorrules')).toBeTruthy()
    expect(screen.getByText('2 rules')).toBeTruthy()
    expect(screen.getByText('3 memory notes')).toBeTruthy()
    expect(screen.getByText('Index: Ready')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'What the agent knows' })).toBeTruthy()
    expect(document.querySelector('[data-agent-context-card]')).toBeTruthy()
    expect(agentContextSpy).toHaveBeenCalledWith({ workspacePath: 'C:/code/demo' })
  })

  it('shows the dim skeleton while the bridge promise is pending', () => {
    agentContextSpy.mockImplementation(() => new Promise(() => {}))
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(document.querySelector('[data-agent-context-card-skeleton]')).toBeTruthy()
    expect(document.querySelector('[data-agent-context-card]')).toBeNull()
  })

  it('renders nothing on IPC rejection', async () => {
    agentContextSpy.mockRejectedValue(new Error('ipc down'))
    const { container } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await waitFor(() => {
      expect(container.querySelector('[data-agent-context-card-skeleton]')).toBeNull()
    })
    expect(container.querySelector('[data-agent-context-card]')).toBeNull()
  })

  it('renders nothing on an error IpcResult', async () => {
    agentContextSpy.mockResolvedValue({ ok: false, error: 'no workspace' })
    const { container } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await waitFor(() => {
      expect(container.querySelector('[data-agent-context-card-skeleton]')).toBeNull()
    })
    expect(container.querySelector('[data-agent-context-card]')).toBeNull()
  })

  it('renders a muted dot and Index: Off for the off state', async () => {
    agentContextSpy.mockResolvedValue({
      ok: true,
      data: { ...fixture, codeIndex: { state: 'off' as const } }
    })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(await screen.findByText('Index: Off')).toBeTruthy()
    expect(document.querySelector('.acc-dot-off')).toBeTruthy()
  })

  it('hides the branch segment when branch is null', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('demo-workspace')
    expect(screen.queryByText('main')).toBeNull()
  })

  it('hides absent rule chips and never shows 0', async () => {
    agentContextSpy.mockResolvedValue({
      ok: true,
      data: { ...fixture, rules: { agentsMd: false, cursorrules: false, vyotiqRulesCount: 0 } }
    })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('demo-workspace')
    expect(screen.queryByText('AGENTS.md')).toBeNull()
    expect(screen.queryByText('.cursorrules')).toBeNull()
    expect(screen.queryByText('0 rules')).toBeNull()
    expect(screen.queryByText('None')).toBeTruthy()
  })

  it('invokes the bridge exactly once per mount and not on rerender', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    const { rerender } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('demo-workspace')
    rerender(<AgentContextCard workspacePath="C:/code/demo" />)
    rerender(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(agentContextSpy).toHaveBeenCalledTimes(1)
  })
})
