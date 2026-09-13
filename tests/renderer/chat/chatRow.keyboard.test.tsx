/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatRow } from '@renderer/app/sidebar/ChatRow'
import type { RunSummary } from '@shared/ipc'

const run: RunSummary = {
  runId: 'run-1',
  goal: 'List files',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now()
}

afterEach(() => {
  cleanup()
})

const noop = () => {}

describe('ChatRow keyboard delete', () => {
  it('opens the inline delete confirm on Delete from a focused row', () => {
    const onDelete = vi.fn()
    render(
      <ChatRow
        run={run}
        workspacePath="/ws/home"
        active={false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={onDelete}
      />
    )
    const row = screen.getByRole('button', { name: 'List files' })
    row.focus()
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(screen.getByRole('group', { name: /Confirm delete List files/ })).toBeTruthy()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('confirms delete via the confirm button and cancels via Escape', () => {
    const onDelete = vi.fn()
    render(
      <ChatRow
        run={run}
        workspacePath="/ws/home"
        active={false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={onDelete}
      />
    )
    const row = screen.getByRole('button', { name: 'List files' })
    row.focus()

    fireEvent.keyDown(row, { key: 'Delete' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: /Confirm delete List files/ })).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()

    fireEvent.keyDown(row, { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete List files' }))
    expect(onDelete).toHaveBeenCalledWith('/ws/home', 'run-1')
  })

  it('does not intercept Delete while renaming', () => {
    render(
      <ChatRow
        run={run}
        workspacePath="/ws/home"
        active={false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )
    fireEvent.doubleClick(screen.getByRole('button', { name: 'List files' }))
    const input = screen.getByLabelText('Rename chat')
    fireEvent.keyDown(input, { key: 'Delete' })
    expect(screen.getByLabelText('Rename chat')).toBeTruthy()
    expect(screen.queryByRole('group', { name: /Confirm delete List files/ })).toBeNull()
  })
})
