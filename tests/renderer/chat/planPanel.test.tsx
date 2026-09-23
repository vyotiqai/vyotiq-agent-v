/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanPanel, planDocument } from '@renderer/features/chat/components/PlanPanel'
import { minimalReadyPlanMarkdown } from '@renderer/features/chat/utils/planDraft'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The contract and the full receipt sit one menu away from the plan. */
async function openView(name: 'Plan' | 'Contract' | 'Receipt'): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'More — contract, receipt' }))
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) }))
}

describe('planDocument', () => {
  it('takes the title from the first # heading and one section per ## heading', () => {
    const doc = planDocument(
      '# Ship the parser\n\nWhy it matters.\n\n## Goal\n\nParse it.\n\n### Detail\n\nDeeper.\n\n## Risks\n\n- One\n'
    )
    expect(doc.title).toBe('Ship the parser')
    expect(doc.lead).toBe('Why it matters.')
    expect(doc.sections.map((s) => s.heading)).toEqual(['Goal', 'Risks'])
    // Deeper headings stay inside their section.
    expect(doc.sections[0]!.body).toBe('Parse it.\n\n### Detail\n\nDeeper.')
  })

  it('keeps a heading inside fenced code as code', () => {
    const doc = planDocument('# T\n\n## Steps\n\n```md\n## not a section\n```\n\n## Risks\n\nNone\n')
    expect(doc.sections.map((s) => s.heading)).toEqual(['Steps', 'Risks'])
    expect(doc.sections[0]!.body).toContain('## not a section')
  })

  it('has no title when the plan does not start with one', () => {
    const doc = planDocument('Intro first.\n\n# Late title\n\n## Goal\n\nG\n')
    expect(doc.title).toBeNull()
    expect(doc.lead).toContain('# Late title')
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

    await openView('Contract')

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

    await openView('Contract')

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

  it('lays the plan out as a document: its title, then each section under a caps label', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'plan.md',
        exists: true,
        content: '# Comprehensive plan\n\n## Goal\n\nAudit the app\n\n## Risks\n\n- Large files\n'
      }
    })

    render(<PlanPanel workspacePath="/ws" runId="run-doc" running={false} />)

    const title = await screen.findByRole('heading', { level: 2, name: 'Comprehensive plan' })
    expect(title).toBeTruthy()
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(labels).toEqual(['Goal', 'Risks'])
    expect(screen.getByRole('heading', { level: 3, name: 'Goal' }).className).toContain('uppercase')
    expect(screen.getByText('Large files')).toBeTruthy()
    // No outline box and no second copy of the tasks: the record has them.
    expect(screen.queryByLabelText('Plan outline')).toBeNull()
    expect(document.querySelector('[data-plan-tasks]')).toBeNull()
  })

  it('leaves out Steps and Done when only once the record shows them live', async () => {
    const plan = '# Plan\n\n## Goal\n\nG\n\n## Steps\n\n1. First step\n\n## Done when\n\n- Tests pass\n'
    const artifacts: Record<string, string | null> = { 'plan.md': plan, 'todos.json': null, 'checks.json': null }
    window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name: string }) => {
      const content = artifacts[req.name] ?? null
      return { ok: true, data: { name: req.name, exists: content !== null, content } }
    })

    const view = render(<PlanPanel workspacePath="/ws" runId="run-a" running={false} />)
    await screen.findByText('First step')
    expect(screen.getByText('Tests pass')).toBeTruthy()
    view.unmount()

    artifacts['todos.json'] = JSON.stringify({ todos: [{ id: '1', content: 'First step', status: 'pending' }] })
    artifacts['checks.json'] = JSON.stringify({
      checks: [{ id: 'c1', text: 'Tests pass', source: 'plan', verdict: null, createdAt: '2026-09-24T09:00:00.000Z' }]
    })
    render(<PlanPanel workspacePath="/ws" runId="run-b" running={false} />)
    await screen.findByRole('heading', { level: 3, name: 'Goal' })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 3, name: 'Steps' })).toBeNull()
      expect(screen.queryByRole('heading', { level: 3, name: 'Done when' })).toBeNull()
    })
  })

  it('opens plan.md in the reader\'s own editor, and says so when it cannot', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { name: 'plan.md', exists: true, content: '# P\n\n## Goal\n\nG\n' }
    })
    const openRunArtifact = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: true })
      .mockResolvedValueOnce({ ok: false, error: 'No application is associated with .md' })
    Object.assign(window.vyotiq, { openRunArtifact })

    render(<PlanPanel workspacePath="/ws" runId="run-open" running={false} />)
    const open = await screen.findByRole('button', { name: 'Open plan.md' })
    fireEvent.click(open)
    await waitFor(() => {
      expect(openRunArtifact).toHaveBeenCalledWith({ workspacePath: '/ws', runId: 'run-open', name: 'plan.md' })
    })
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(open)
    expect((await screen.findByRole('alert')).textContent).toBe('No application is associated with .md')
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
    await openView('Receipt')

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
    await openView('Receipt')

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

    await openView('Contract')

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
    // Back to the plan in one step.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the plan' }))
    expect(screen.getByLabelText('Plan panel')).toBeTruthy()
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
    await openView('Receipt')

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
    await openView('Receipt')

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
    await openView('Receipt')

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

  it('shows the empty plan state when only todos.json exists — the record shows the steps', async () => {
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
      expect(screen.getByText('No plan yet')).toBeTruthy()
    })
    expect(screen.queryByText('Only task')).toBeNull()
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
    expect(screen.queryByText('No plan yet')).toBeNull()
  })
})
