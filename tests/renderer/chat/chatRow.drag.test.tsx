/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { ChatRow } from '@renderer/app/sidebar/ChatRow'
import {
  isSessionDragEvent,
  markSessionDragEnd,
  SESSION_DRAG_MIME
} from '@renderer/lib/chat/chatPaneLayout'
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

  // The session-drag flag is module state; reset it so no test leaks into another.
  afterEach(() => {
    markSessionDragEnd()
    vi.useRealTimers()
  })

  it('unmounts the draggable row while renaming', () => {
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
    // The row button is gone, so no dragstart can fire from a renaming row.
    expect(screen.queryByRole('button', { name: 'List files' })).toBeNull()
  })

  it('guards dragstart while confirming delete', () => {
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
    fireEvent.keyDown(row, { key: 'Delete' })
    expect(screen.getByRole('button', { name: 'Confirm delete List files' })).toBeTruthy()

    const setData = vi.fn()
    const dragEvent = createEvent.dragStart(row, {
      dataTransfer: { types: [], setData, effectAllowed: 'copy' }
    })
    const preventDefault = vi.spyOn(dragEvent, 'preventDefault')
    fireEvent(row, dragEvent)
    expect(preventDefault).toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
    // No markSessionDragStart: a text/plain event is not a session drag.
    expect(isSessionDragEvent({ types: ['text/plain'] } as DataTransfer)).toBe(false)
  })

  it('clears the session drag flag on dragend', () => {
    vi.useFakeTimers()
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
      dataTransfer: { types: [], setData, effectAllowed: 'copy' }
    })
    vi.advanceTimersByTime(1000)
    const plainOnly = { types: ['text/plain'] } as DataTransfer
    expect(isSessionDragEvent(plainOnly)).toBe(true)

    fireEvent.dragEnd(row)
    expect(isSessionDragEvent(plainOnly)).toBe(false)
  })
})
