/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'

afterEach(cleanup)

const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Regroup Settings', at: at(0) },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'Settings regrouped.', at: at(30) },
  { kind: 'message', id: 'user-2', role: 'user', content: 'Also move Shortcuts under App', at: at(60) },
  { kind: 'message', id: 'a3', role: 'assistant', content: 'Moved.', at: at(90) }
]

const FORK = "Fork from here: a new task with the record up to this instruction's result"

describe('forking from an instruction', () => {
  it('hands over the brief’s message index from each instruction', () => {
    const onForkFrom = vi.fn()
    const model = buildRecordModel(items, { running: false })
    render(<TaskRecord model={model} options={{ running: false }} messageCount={4} onForkFrom={onForkFrom} />)
    fireEvent.click(screen.getByRole('button', { name: FORK }))
    expect(onForkFrom).toHaveBeenLastCalledWith(2)
    fireEvent.click(screen.getByRole('button', { name: /Run 1/ }))
    const forks = screen.getAllByRole('button', { name: FORK })
    expect(forks).toHaveLength(2)
    fireEvent.click(forks[0]!)
    expect(onForkFrom).toHaveBeenLastCalledWith(0)
  })

  it('offers no fork while the task runs', () => {
    const model = buildRecordModel(items, { running: true })
    render(<TaskRecord model={model} options={{ running: true }} messageCount={4} onForkFrom={vi.fn()} />)
    expect(screen.queryByRole('button', { name: FORK })).toBeNull()
  })
})
