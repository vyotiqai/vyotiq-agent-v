/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PlanPanel, parsePlanOutline, outlineIndentRem } from '@renderer/features/chat/components/PlanPanel'
import { minimalReadyPlanMarkdown } from '@renderer/features/chat/utils/planDraft'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('parsePlanOutline', () => {
  it('skips h1 when deeper headings exist and allocates collision-safe ids', () => {
    const outline = parsePlanOutline(
      '# Title\n\n## Goal\n\n## Goal\n\n### Detail\n\n- [x] done\n- [ ] todo\n'
    )
    expect(outline.headings.map((h) => h.text)).toEqual(['Goal', 'Goal', 'Detail'])
    expect(outline.headings.map((h) => h.level)).toEqual([2, 2, 3])
    // Ids still allocate the h1 slug so they match MarkdownContent headingIds.
    expect(outline.headings.map((h) => h.id)).toEqual(['goal', 'goal-1', 'detail'])
    expect(outline.checked).toBe(1)
    expect(outline.unchecked).toBe(1)
  })

  it('keeps h1 when it is the only heading level', () => {
    const outline = parsePlanOutline('# Solo\n\nBody text here.\n')
    expect(outline.headings).toEqual([{ text: 'Solo', id: 'solo', level: 1 }])
  })

  it('indents relative to the shallowest visible level', () => {
    expect(outlineIndentRem(2, 2)).toBe(0)
    expect(outlineIndentRem(3, 2)).toBe(0.65)
    expect(outlineIndentRem(1, 1)).toBe(0)
  })
})

describe('PlanPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        readRunArtifact: vi.fn(),
        slashCommandsOpenFile: vi.fn()
      }
    })
  })

  it('shows empty contract state when runId is null without calling IPC', async () => {
    render(
      <PlanPanel workspacePath="/ws" runId={null} running={false} />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Contract' }))

    await waitFor(() => {
      expect(screen.getByText('No contract yet')).toBeTruthy()
    })
    expect(screen.getByText('The run contract is created when a chat starts.')).toBeTruthy()
    expect(window.vyotiq.readRunArtifact).not.toHaveBeenCalled()
  })

  it('loads contract.md via readRunArtifact when workspace and run are set', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { name: 'contract.md', exists: true, content: '## Goal\n\nShip it\n' }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-1" running={false} />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Contract' }))

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalledWith({
        workspacePath: '/ws',
        runId: 'run-1',
        name: 'contract.md'
      })
    })
    await waitFor(() => {
      expect(screen.getByText('Ship it')).toBeTruthy()
    })
  })

  it('loads plan.md on mount when draft is ready', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nAudit the app\n'
      }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-2" running={false} />
    )

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalledWith({
        workspacePath: '/ws',
        runId: 'run-2',
        name: 'plan.md'
      })
    })
    await waitFor(() => {
      expect(screen.getByText('Audit the app')).toBeTruthy()
    })
  })

  it('outline click scrolls to matching heading id', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content:
          `${minimalReadyPlanMarkdown()}\n## Scope\n\nDocument the verified scope thoroughly.\n\n## Findings\n\n- [x] first checklist item here\n- [ ] second checklist item here\n`
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-outline" running={false} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Plan outline')).toBeTruthy()
    })
    expect(screen.getByText('Outline')).toBeTruthy()
    // The stub's Done-when `- [ ]` counts as the first unchecked item; the
    // appended Findings section adds one checked and one unchecked.
    expect(screen.getByText('Checklist 1/3')).toBeTruthy()
    // H1 omitted from nav when H2s exist.
    const outline = screen.getByLabelText('Plan outline')
    expect(within(outline).queryByRole('button', { name: 'Comprehensive plan' })).toBeNull()

    fireEvent.click(within(outline).getByRole('button', { name: 'Findings' }))

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled()
    })
    expect(document.getElementById('findings')).toBeTruthy()
  })

  it('hides the outline checklist count when the run has todos', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name?: string }) => {
      if (req.name === 'todos.json') {
        return {
          ok: true,
          data: {
            name: 'todos.json',
            exists: true,
            content: JSON.stringify({
              updatedAt: '2026-01-01T00:00:00.000Z',
              todos: [{ id: '1', content: 'Ship it', status: 'in_progress' }]
            })
          }
        }
      }
      return {
        ok: true,
        data: {
          name: 'plan.md',
          exists: true,
          content: `${minimalReadyPlanMarkdown()}\n## Scope\n\nDocument the verified scope thoroughly.\n\n## Findings\n\n- [x] first checklist item here\n- [ ] second checklist item here\n`
        }
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-outline-todos" running={false} />)

    await waitFor(() => {
      expect(screen.getByText('Ship it')).toBeTruthy()
    })
    expect(screen.getByLabelText('Plan outline')).toBeTruthy()
    // The Tasks section is the live count; the markdown-checkbox count is hidden.
    expect(screen.queryByText(/Checklist /)).toBeNull()
  })

  it('loads and renders receipt.json summary', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-07-30T00:00:00.000Z',
          runId: 'run-3',
          status: 'error',
          statusError: 'Insufficient Balance',
          step: 2,
          compactionCount: 0,
          toolStats: { totalCalls: 3, ok: 2, failed: 1, byName: {} },
          failureClusters: [{ key: 'edit: boom', count: 1 }],
          unreadEditPaths: ['contract.md'],
          wroteFiles: ['AGENTS.md'],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: '## Done when\n\n- Ship it',
          tokenUsage: {
            billedInputTokens: 100,
            inputTokens: 50,
            outputTokens: 10,
            reasoningTokens: 5
          }
        })
      }
    })

    const openFile = vi.fn()
    render(<PlanPanel workspacePath="/ws" runId="run-err" running={false} onOpenFile={openFile} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Receipt' }))

    await waitFor(() => {
      expect(screen.getByText('Insufficient Balance')).toBeTruthy()
    })
    const badge = screen.getByText('error')
    expect(badge.getAttribute('data-receipt-status')).toBe('error')
    expect(badge.className).toMatch(/text-danger/)
    expect(screen.getByText(/Done when/)).toBeTruthy()
    expect(screen.getByText('billed in')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    expect(openFile).toHaveBeenCalledWith('AGENTS.md')
  })

  it('shows the verification state on the receipt summary', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name?: string }) => {
      if (req.name !== 'receipt.json') {
        return { ok: true, data: { name: req.name ?? '', exists: false, content: null } }
      }
      return {
        ok: true,
        data: {
          name: 'receipt.json',
          exists: true,
          content: JSON.stringify({
            version: 5,
            writtenAt: '2026-07-30T00:00:00.000Z',
            runId: 'run-verify',
            status: 'done',
            step: 3,
            compactionCount: 0,
            toolStats: { totalCalls: 2, ok: 2, failed: 0, byName: {} },
            failureClusters: [],
            unreadEditPaths: [],
            wroteFiles: ['a.ts'],
            diagnostics: { calls: 1, ok: 1, clean: 1 },
            verification: {
              lastMutationAt: '2026-07-30T00:01:00.000Z',
              lastCheckAt: '2026-07-30T00:00:00.000Z',
              verifiedAfterLastMutation: false
            },
            contractExcerpt: ''
          })
        }
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-verify" running={false} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Receipt' }))

    await waitFor(() => {
      expect(screen.getByText(/File mutations after last successful check/)).toBeTruthy()
    })
    const badge = screen.getByText(/File mutations after last successful check/)
    expect(badge.getAttribute('data-receipt-verification')).toBe('false')
    expect(badge.className).toMatch(/text-warning/)
  })

  it('ignores stale tab responses when switching tabs quickly', async () => {
    let resolvePlan: ((v: unknown) => void) | undefined
    const planPromise = new Promise((resolve) => {
      resolvePlan = resolve
    })
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(({ name }) => {
      if (name === 'plan.md') return planPromise
      return Promise.resolve({
        ok: true,
        data: { name: 'contract.md', exists: true, content: '## Goal\n\nContract win\n' }
      })
    })

    render(<PlanPanel workspacePath="/ws" runId="run-race" running={false} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Contract' }))

    await waitFor(() => {
      expect(screen.getByText('Contract win')).toBeTruthy()
    })

    resolvePlan?.({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nStale plan text\n'
      }
    })

    await waitFor(() => {
      expect(screen.queryByText('Stale plan text')).toBeNull()
      expect(screen.getByText('Contract win')).toBeTruthy()
    })
    expect(screen.getByLabelText('Contract panel')).toBeTruthy()
  })

  it('hides a prior done receipt while the run is live', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-07-30T00:00:00.000Z',
          runId: 'run-stale',
          status: 'done',
          invokeId: 1,
          step: 2,
          compactionCount: 0,
          toolStats: { totalCalls: 1, ok: 1, failed: 0, byName: {} },
          failureClusters: [],
          unreadEditPaths: [],
          wroteFiles: [],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: ''
        })
      }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-stale" running invokeId={2} />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Receipt' }))

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.getByText('Receipt updating')).toBeTruthy()
    })
    expect(
      screen.getByText(/Prior receipt is hidden while this run is live/)
    ).toBeTruthy()
  })

  it('hides a receipt when invokeId mismatches a live run', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-07-30T00:00:00.000Z',
          runId: 'run-mismatch',
          status: 'running',
          invokeId: 1,
          step: 1,
          compactionCount: 0,
          toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
          failureClusters: [],
          unreadEditPaths: [],
          wroteFiles: [],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: ''
        })
      }
    })

    render(
      <PlanPanel workspacePath="/ws" runId="run-mismatch" running invokeId={2} />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Receipt' }))

    await waitFor(() => {
      expect(screen.getByText('Receipt updating')).toBeTruthy()
    })
  })

  it('rejects invalid receipt.json via safeParse', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({ version: 1, runId: 'bad' })
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-bad" running={false} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Receipt' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid receipt.json')).toBeTruthy()
    })
  })

  it('does not poll while inactive even when the agent is running', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nShip it\n'
      }
    })

    const pollCalls = (): number =>
      setIntervalSpy.mock.calls.filter((args) => args[1] === 2000).length

    const { rerender } = render(
      <PlanPanel workspacePath="/ws" runId="run-poll" running active={false} />
    )

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalled()
    })
    expect(pollCalls()).toBe(0)

    rerender(<PlanPanel workspacePath="/ws" runId="run-poll" running active />)
    await waitFor(() => {
      expect(pollCalls()).toBeGreaterThan(0)
    })
  })

  it('shows Continue in Agent when plan mode, idle, and draft ready', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: minimalReadyPlanMarkdown()
      }
    })
    const onContinueInAgent = vi.fn()

    render(
      <PlanPanel
        workspacePath="/ws"
        runId="run-continue"
        running={false}
        agentMode="plan"
        onContinueInAgent={onContinueInAgent}
      />
    )

    const btn = await screen.findByRole('button', { name: 'Continue in Agent' })
    fireEvent.click(btn)
    expect(onContinueInAgent).toHaveBeenCalledTimes(1)
  })

  it('hides Continue in Agent when agent mode or running', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: minimalReadyPlanMarkdown()
      }
    })
    const onContinueInAgent = vi.fn()

    const { rerender } = render(
      <PlanPanel
        workspacePath="/ws"
        runId="run-hide"
        running={false}
        agentMode="agent"
        onContinueInAgent={onContinueInAgent}
      />
    )

    await waitFor(() => {
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalled()
    })
    expect(screen.queryByRole('button', { name: 'Continue in Agent' })).toBeNull()

    rerender(
      <PlanPanel
        workspacePath="/ws"
        runId="run-hide"
        running
        agentMode="plan"
        onContinueInAgent={onContinueInAgent}
      />
    )
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Continue in Agent' })).toBeNull()
    })
  })

  it('shows Continue tool-fail hint from receipt while on plan tab', async () => {
    const receipt = {
      version: 5,
      writtenAt: '2026-07-30T00:00:00.000Z',
      runId: 'run-fail',
      status: 'done',
      step: 2,
      compactionCount: 0,
      toolStats: { totalCalls: 3, ok: 1, failed: 2, byName: {} },
      failureClusters: [{ key: 'terminal:exit', count: 2 }],
      unreadEditPaths: [],
      wroteFiles: [],
      diagnostics: { calls: 0, ok: 0, clean: 0 },
      contractExcerpt: ''
    }
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(({ name }) => {
      if (name === 'plan.md') {
        return Promise.resolve({
          ok: true,
          data: {
            name: 'plan.md',
            exists: true,
            content: minimalReadyPlanMarkdown()
          }
        })
      }
      if (name === 'receipt.json') {
        return Promise.resolve({
          ok: true,
          data: { name: 'receipt.json', exists: true, content: JSON.stringify(receipt) }
        })
      }
      return Promise.resolve({ ok: true, data: { name, exists: false, content: null } })
    })

    render(
      <PlanPanel
        workspacePath="/ws"
        runId="run-fail"
        running={false}
        agentMode="plan"
        onContinueInAgent={() => undefined}
      />
    )

    await screen.findByRole('button', { name: 'Continue in Agent' })
    await waitFor(() => {
      expect(screen.getByText(/2 tool failures · terminal:exit/)).toBeTruthy()
    })
  })

  it('clears Loading when a quiet poll supersedes a non-quiet load', async () => {
    let resolveSlow: ((v: unknown) => void) | undefined
    const slow = new Promise((resolve) => {
      resolveSlow = resolve
    })
    let call = 0
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(({ name }) => {
      call += 1
      if (name === 'plan.md' && call === 1) return slow
      if (name === 'plan.md') {
        return Promise.resolve({
          ok: true,
          data: {
            name: 'plan.md',
            exists: true,
            content: '# Plan\n\n1. Quiet win\n'
          }
        })
      }
      return Promise.resolve({
        ok: true,
        data: { name: 'receipt.json', exists: false, content: null }
      })
    })

    const { rerender } = render(
      <PlanPanel workspacePath="/ws" runId="run-load" running={false} active />
    )
    await waitFor(() => {
      expect(screen.getByText('Loading…')).toBeTruthy()
    })

    // Flip running false→true→false to trigger quiet reload while slow load is in flight.
    rerender(<PlanPanel workspacePath="/ws" runId="run-load" running active />)
    rerender(<PlanPanel workspacePath="/ws" runId="run-load" running={false} active />)

    await waitFor(() => {
      expect(call).toBeGreaterThan(1)
    })

    resolveSlow?.({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Plan\n\n1. Stale slow\n'
      }
    })

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })
  })

  it('uses plan-mode empty copy when agentMode is plan', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { name: 'plan.md', exists: false, content: null }
    })
    render(
      <PlanPanel workspacePath="/ws" runId="run-empty" running={false} agentMode="plan" />
    )
    await waitFor(() => {
      expect(screen.getByText(/Draft plan.md for this run/)).toBeTruthy()
    })
    expect(screen.queryByText(/Switch to Plan mode/)).toBeNull()
  })

  it('renders Tasks checklist from todos.json above plan narrative', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name?: string }) => {
      if (req.name === 'todos.json') {
        return {
          ok: true,
          data: {
            name: 'todos.json',
            exists: true,
            content: JSON.stringify({
              updatedAt: '2026-01-01T00:00:00.000Z',
              todos: [
                { id: '1', content: 'Map project', status: 'completed' },
                { id: '2', content: 'Run tests', status: 'in_progress' }
              ]
            })
          }
        }
      }
      if (req.name === 'plan.md') {
        return {
          ok: true,
          data: {
            name: 'plan.md',
            exists: true,
            content: '# Comprehensive plan\n\n## Goal\n\nAudit the app\n'
          }
        }
      }
      if (req.name === 'receipt.json') {
        return { ok: true, data: { name: 'receipt.json', exists: false, content: null } }
      }
      return { ok: false, error: 'unexpected' }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-tasks" running={false} />)

    await waitFor(() => {
      expect(document.querySelector('[data-plan-tasks]')).toBeTruthy()
    })
    expect(screen.getByText('Map project')).toBeTruthy()
    expect(screen.getByText('Run tests')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText('Audit the app')).toBeTruthy()
    })
  })

  it('shows Tasks section when only todos.json exists (no plan draft)', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name?: string }) => {
      if (req.name === 'todos.json') {
        return {
          ok: true,
          data: {
            name: 'todos.json',
            exists: true,
            content: JSON.stringify({
              todos: [{ id: '1', content: 'Only task', status: 'pending' }]
            })
          }
        }
      }
      return { ok: true, data: { name: req.name ?? 'plan.md', exists: false, content: null } }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-todos-only" running={false} />)

    await waitFor(() => {
      expect(screen.getByText('Only task')).toBeTruthy()
    })
    expect(document.querySelector('[data-plan-tasks]')).toBeTruthy()
    expect(screen.queryByText('No plan drafted yet')).toBeNull()
  })

  it('renders in-progress plan stub instead of empty state', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name?: string }) => {
      if (req.name === 'plan.md') {
        return {
          ok: true,
          data: {
            name: 'plan.md',
            exists: true,
            content:
              '# Plan\n\n_Draft the plan here. Update as you learn. Do not edit product source in Plan mode._\n'
          }
        }
      }
      if (req.name === 'receipt.json') {
        return { ok: true, data: { name: 'receipt.json', exists: false, content: null } }
      }
      return { ok: true, data: { name: req.name ?? 'plan.md', exists: false, content: null } }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-stub" running={false} />)

    await waitFor(() => {
      expect(screen.getByText(/Draft the plan here/i)).toBeTruthy()
    })
    expect(screen.queryByText('No plan drafted yet')).toBeNull()
  })
})
