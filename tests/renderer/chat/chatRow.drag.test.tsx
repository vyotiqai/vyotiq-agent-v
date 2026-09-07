/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatRow } from '@renderer/app/sidebar/ChatRow'
import { SESSION_DRAG_MIME } from '@renderer/lib/chat/chatPaneLayout'
import type { RunSummary } from '@shared/ipc'

const run: RunSummary = {
  runId: 'run-1',
  goal: 'List files',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now()
}

const noop = () => {}

describe('ChatRow drag', () => {
  it('marks open vs focused session rows for multi-pane sidebar', () => {
    const { rerender } = render(
      <ChatRow
        run={run}
        workspacePath="/ws/home"
        active
        focused={false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )
    const row = screen.getByRole('button', { name: 'List files' })
    expect(row.getAttribute('data-session-open')).toBe('1')
    expect(row.getAttribute('data-session-focused')).toBe('0')

    rerender(
      <ChatRow
        run={run}
        workspacePath="/ws/home"
        active
        focused
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )
    expect(screen.getByRole('button', { name: 'List files' }).getAttribute('data-session-focused')).toBe('1')
  })

  it('sets session drag payload on dragstart', () => {
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
    const row = screen.getByRole('button', { name: 'List files' })
    const setData = vi.fn()
    fireEvent.dragStart(row, {
      dataTransfer: {
        types: [],
        setData,
        effectAllowed: 'copy'
      }
    })
    expect(setData).toHaveBeenCalledWith(
      SESSION_DRAG_MIME,
      JSON.stringify({ workspacePath: '/ws/home', runId: 'run-1' })
    )
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      JSON.stringify({ workspacePath: '/ws/home', runId: 'run-1' })
    )
  })

  it('does not mark nested instance rows as draggable', () => {
    render(
      <ChatRow
        run={{ ...run, runId: 'child-1', inlineInstance: true, parentRunId: 'run-1' }}
        workspacePath="/ws/home"
        active={false}
        nested
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )
    const row = screen.getByRole('button', { name: 'List files' })
    expect(row.getAttribute('draggable')).toBe('false')
    const setData = vi.fn()
    fireEvent.dragStart(row, {
      dataTransfer: {
        types: [],
        setData,
        effectAllowed: 'copy'
      }
    })
    expect(setData).not.toHaveBeenCalled()
  })

  it('cancels rename on Escape', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Rename List files' }))
    const input = screen.getByLabelText('Rename chat')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Rename chat')).toBeNull()
  })

  it('starts rename on double-click', () => {
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
    expect(screen.getByLabelText('Rename chat')).toBeTruthy()
  })
})
