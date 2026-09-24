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

/** Two runs, as messagesToUiItems ids them: the user message id carries its index. */
const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Regroup Settings', at: at(0) },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'Settings regrouped.', at: at(30) },
  { kind: 'message', id: 'user-2', role: 'user', content: 'Also move Shortcuts under App', at: at(60) },
  { kind: 'message', id: 'a3', role: 'assistant', content: 'Moved.', at: at(90) }
]

describe('rewinding from the record', () => {
  it('hands over the brief’s message index and the run’s number', () => {
    const onRevert = vi.fn()
    const model = buildRecordModel(items, { running: false })
    render(<TaskRecord model={model} options={{ running: false }} messageCount={4} onRevert={onRevert} />)
    // The latest run is open; run 1 is folded into its history row.
    const rewind = screen.getByRole('button', { name: 'Rewind files and record to before this instruction' })
    fireEvent.click(rewind)
    expect(onRevert).toHaveBeenLastCalledWith(2, 2)
    fireEvent.click(screen.getByRole('button', { name: /Run 1/ }))
    const rewinds = screen.getAllByRole('button', { name: 'Rewind files and record to before this instruction' })
    expect(rewinds).toHaveLength(2)
    fireEvent.click(rewinds[0]!)
    expect(onRevert).toHaveBeenLastCalledWith(0, 1)
  })

  it('offers no rewind while the task runs', () => {
    const model = buildRecordModel(items, { running: true })
    render(<TaskRecord model={model} options={{ running: true }} messageCount={4} onRevert={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Rewind files and record to before this instruction' })).toBeNull()
  })
})
