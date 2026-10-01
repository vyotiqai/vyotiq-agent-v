/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { unreachableServiceInTurn } from '@shared/utils/unreachableService'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RecordActionsContext, latestRetryableErrorId, type RecordActions } from '@renderer/features/task/record/WorkItems'

/**
 * A failed task that could not reach something it needed offers, beside
 * Retry, to have it mock that thing instead — named from the failure itself,
 * on the latest failure only, and never while the run is live.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const user = (id: string, text: string, s: number): UiItem => ({ kind: 'message', id, role: 'user', content: text, at: at(s) })
const command = (id: string, cmd: string, content: string, s: number): UiItem => ({
  kind: 'tool',
  id,
  at: at(s),
  endedAt: at(s + 1),
  tool: { id, name: 'terminal', summary: cmd, status: 'done', content, argsPreview: JSON.stringify({ command: cmd }) }
})
const runError = (id: string, message: string, code: string, s: number): UiItem => ({ kind: 'run_error', id, message, code, at: at(s) })

const REFUSED = 'cwd: /ws\n\n ✗ tests/search.test.ts > serves a repeat query from the cache\nstderr:\nError: connect ECONNREFUSED 127.0.0.1:6379\nexit_code: 1'

function show(items: UiItem[], options: BuildOptions, extra: Partial<RecordActions> = {}) {
  const retryableErrorId = latestRetryableErrorId(items, options.running)
  const actions: RecordActions = {
    retryableErrorId,
    onRetry: vi.fn(),
    mockTarget: retryableErrorId ? unreachableServiceInTurn(items) : null,
    onFollowUp: vi.fn(),
    ...extra
  }
  const view = render(
    <RecordActionsContext.Provider value={actions}>
      <TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} />
    </RecordActionsContext.Provider>
  )
  return { actions, ...view }
}

describe('Ask it to mock', () => {
  it('names what refused and sends the follow-up when clicked', () => {
    const items = [
      user('u1', 'Cache repository search results in Redis', 0),
      command('t1', 'pnpm test', REFUSED, 2),
      runError('e1', 'The tests could not run.', 'AGENT_LOOP', 5)
    ]
    const { getByRole, actions } = show(items, { running: false, failed: true })
    const alert = getByRole('alert')
    const button = within(alert).getByRole('button', { name: 'Ask it to mock Redis' })
    fireEvent.click(button)
    expect(actions.onFollowUp).toHaveBeenCalledWith(
      'Mock Redis instead of connecting to it, so the work can be verified without it, then carry on.'
    )
  })

  it('sits beside Retry, quieter than it', () => {
    const items = [
      user('u1', 'Cache search results', 0),
      command('t1', 'pnpm test', REFUSED, 2),
      runError('e1', 'Connection lost', 'PROVIDER_NETWORK', 5)
    ]
    const { getByRole } = show(items, { running: false, failed: true })
    const alert = getByRole('alert')
    const retry = within(alert).getByRole('button', { name: 'Retry' })
    const mock = within(alert).getByRole('button', { name: 'Ask it to mock Redis' })
    expect(Boolean(retry.compareDocumentPosition(mock) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    // Ghost beside Retry's outline: the one to try first stays the louder one.
    expect(mock.className).toContain('text-secondary')
    expect(mock.className).not.toContain('border')
    expect(mock.className).toContain('focus-visible:vy-focus-ring')
  })

  it('shows nothing when the failure names nothing it could not reach', () => {
    const items = [
      user('u1', 'Fix the parser', 0),
      command('t1', 'pnpm test', 'cwd: /ws\n\nExpected 2, received 3\nexit_code: 1', 2),
      runError('e1', 'The tests could not run.', 'AGENT_LOOP', 5)
    ]
    const { getByRole } = show(items, { running: false, failed: true })
    expect(within(getByRole('alert')).queryByRole('button', { name: /mock/i })).toBeNull()
  })

  it('is not offered while the run is live', () => {
    const items = [user('u1', 'Cache search results', 0), command('t1', 'pnpm test', REFUSED, 2)]
    const { queryByRole } = show(items, { running: true })
    expect(queryByRole('button', { name: /mock/i })).toBeNull()
  })

  it('is offered on the latest failure only, not on an earlier one', () => {
    const items = [
      user('u1', 'Cache search results', 0),
      command('t1', 'pnpm test', REFUSED, 2),
      runError('e1', 'The tests could not run.', 'AGENT_LOOP', 5),
      user('u2', 'Use the in-memory cache instead', 10),
      { kind: 'message', id: 'a2', role: 'assistant', content: 'Switched to the in-memory cache.', at: at(20) } as UiItem
    ]
    const { queryByRole } = show(items, { running: false })
    expect(queryByRole('button', { name: /mock/i })).toBeNull()
  })
})
