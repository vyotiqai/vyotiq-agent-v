/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import type { UiItem } from '@shared/transcript'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import { ReviewChecks, coverCheckInstruction } from '@renderer/features/chat/components/ReviewChecks'
import { checksRevisionOf } from '@renderer/features/task/useRunChecks'

const at = '2026-09-30T10:00:00.000Z'
const check = (id: string, text: string, verdict: DoneWhenCheck['verdict'], evidence?: string): DoneWhenCheck => ({
  id,
  text,
  source: 'brief',
  verdict,
  createdAt: at,
  ...(evidence ? { evidence, markedAt: at } : {})
})

const CHECKS = [
  check('c1', 'pnpm test passes', 'met', 'exit 0 · 71 tests'),
  check('c2', 'Retries never run twice for one event', 'not_met', 'No test covers two workers taking the same event'),
  check('c3', 'A failing webhook lands in dead letters', 'met', 'webhooks.test.ts › parks after 5 attempts'),
  check('c4', 'The runbook mentions the retry schedule', null)
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ReviewChecks', () => {
  it('leads with the open checks and folds the met ones to a count', () => {
    render(<ReviewChecks checks={CHECKS} inset="px-4" onAsk={vi.fn()} />)
    const open = Array.from(document.querySelectorAll('[data-check]')).map((el) => el.getAttribute('data-check'))
    expect(open).toEqual(['c2', 'c4'])
    expect(screen.getByText('No test covers two workers taking the same event')).toBeTruthy()
    expect(screen.getByText('Not checked before the run ended')).toBeTruthy()
    const fold = screen.getByRole('button', { name: /2 of 4 checks met/ })
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('pnpm test passes')).toBeNull()

    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('pnpm test passes')).toBeTruthy()
    expect(screen.getByText('exit 0 · 71 tests')).toBeTruthy()
  })

  it('tints only the open checks, the one block here that asks something of you', () => {
    render(<ReviewChecks checks={CHECKS} inset="px-4" onAsk={vi.fn()} />)
    for (const id of ['c2', 'c4']) {
      expect(document.querySelector(`[data-check="${id}"]`)!.classList.contains('bg-warning-soft')).toBe(true)
    }
    fireEvent.click(screen.getByRole('button', { name: /checks met/ }))
    expect(document.querySelector('[data-check="c1"]')!.classList.contains('bg-warning-soft')).toBe(false)
  })

  it('hands an open check back to the agent as an instruction', () => {
    const onAsk = vi.fn()
    render(<ReviewChecks checks={CHECKS} inset="px-3" onAsk={onAsk} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask it to cover this' }))
    expect(onAsk).toHaveBeenCalledWith(coverCheckInstruction(CHECKS[1]))
    expect(onAsk.mock.calls[0][0]).toContain('c2')
    expect(onAsk.mock.calls[0][0]).toContain('No test covers two workers')
    fireEvent.click(screen.getByRole('button', { name: 'Ask it to check' }))
    expect(onAsk.mock.calls[1][0]).toContain('was never checked')
  })

  it('says only the count when every check is met, and nothing when there are none', () => {
    const { rerender } = render(<ReviewChecks checks={[CHECKS[0], CHECKS[2]]} inset="px-4" />)
    expect(document.querySelectorAll('[data-check]').length).toBe(0)
    expect(screen.getByRole('button', { name: /2 of 2 checks met/ })).toBeTruthy()
    rerender(<ReviewChecks checks={[]} inset="px-4" />)
    expect(document.querySelector('[data-review-checks]')).toBeNull()
  })

  it('offers no ask button without somewhere to send it', () => {
    render(<ReviewChecks checks={CHECKS} inset="px-4" />)
    expect(screen.queryByRole('button', { name: 'Ask it to cover this' })).toBeNull()
  })
})

describe('checksRevisionOf', () => {
  const tool = (id: string, name: string, status: 'running' | 'done'): UiItem => ({
    kind: 'tool',
    id,
    at,
    tool: { id, name, status, summary: '' }
  })
  it('moves only when a checks writer settles, or the run starts or stops', () => {
    const base = [tool('t1', 'read', 'done')]
    const r0 = checksRevisionOf(base, false)
    expect(checksRevisionOf([...base, tool('t2', 'check_done_when', 'running')], false)).toBe(r0)
    expect(checksRevisionOf([...base, tool('t2', 'check_done_when', 'done')], false)).not.toBe(r0)
    expect(checksRevisionOf(base, true)).not.toBe(r0)
  })
})

describe('ChangesPanel: done-when checks', () => {
  let readRunArtifact: ReturnType<typeof vi.fn>
  beforeEach(() => {
    readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { exists: true, content: JSON.stringify({ checks: CHECKS, lastId: 4 }) }
    })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        readRunArtifact,
        gitStatus: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            kind: 'ok',
            status: { branch: 'main', files: [], truncated: false, fileCount: 0, added: 0, removed: 0, hasRemote: false, hasCommits: true }
          }
        }),
        gitLog: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        gitBranches: vi.fn().mockResolvedValue({ ok: true, data: [{ name: 'main', current: true }] })
      }
    })
  })

  it('leads This task with the open checks once the run has stopped, reading the run’s checks.json', async () => {
    const onHandToAgent = vi.fn()
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} runId="run-1" onHandToAgent={onHandToAgent} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask it to cover this' }))
    expect(readRunArtifact).toHaveBeenCalledWith({ workspacePath: '/ws', runId: 'run-1', name: 'checks.json' })
    expect(onHandToAgent).toHaveBeenCalledWith(coverCheckInstruction(CHECKS[1]))
  })

  it('shows the checks in the full review too', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} runId="run-1" variant="review" reviewTitle="Retry webhooks" onHandToAgent={vi.fn()} />)
    expect(await screen.findByRole('region', { name: 'Done-when checks' })).toBeTruthy()
  })

  it('holds them back while the run works: the verdicts are still coming', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} runId="run-1" running />)
    await waitFor(() => expect(readRunArtifact).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Done-when checks' })).toBeNull()
  })

  it('keeps them to This task: a git scope is about the working tree, not the run', async () => {
    render(<ChangesPanel items={[]} workspacePath="/ws" gitRevision={1} runId="run-1" preferredScope="uncommitted" />)
    await waitFor(() => expect(readRunArtifact).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Done-when checks' })).toBeNull()
  })
})
