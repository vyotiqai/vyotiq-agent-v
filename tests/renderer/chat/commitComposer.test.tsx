/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommitComposer } from '@renderer/features/chat/components/CommitComposer'

afterEach(() => {
  cleanup()
})

function renderComposer(hasRemote: boolean) {
  const onCommit = vi.fn()
  render(
    <CommitComposer
      message="Update files"
      onMessageChange={() => {}}
      busy={false}
      hasRemote={hasRemote}
      onCommit={onCommit}
    />
  )
  return { onCommit, input: screen.getByLabelText('Commit message') }
}

describe('CommitComposer keydown', () => {
  it('commits without push on plain Enter', () => {
    const { onCommit, input } = renderComposer(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(false)
  })

  it('commits and pushes on Ctrl/Cmd+Enter when a remote exists', () => {
    const { onCommit, input } = renderComposer(true)
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledWith(true)
    onCommit.mockClear()
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledWith(true)
  })

  it('falls back to a plain commit on Ctrl+Enter without a remote', () => {
    const { onCommit, input } = renderComposer(false)
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(onCommit).toHaveBeenCalledWith(false)
  })

  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    const onCommit = vi.fn()
    render(
      <CommitComposer
        message="Update files"
        onMessageChange={() => {}}
        busy={false}
        hasRemote
        onCommit={onCommit}
        onCancel={onCancel}
      />
    )
    const input = screen.getByLabelText('Commit message')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('CommitComposer generation notice', () => {
  it('renders the fallback reason with aria-live and keeps the composer usable', () => {
    const onCommit = vi.fn()
    render(
      <CommitComposer
        message="Update 3 files"
        onMessageChange={() => {}}
        busy={false}
        hasRemote
        generationNotice="Generation timed out"
        onCommit={onCommit}
      />
    )

    const notice = screen.getByText(/Generation unavailable: Generation timed out/)
    expect(notice.getAttribute('aria-live')).toBe('polite')
    expect((screen.getByLabelText('Commit message') as HTMLInputElement).value).toBe(
      'Update 3 files'
    )
    const commit = screen.getByRole('button', { name: 'Commit' }) as HTMLButtonElement
    expect(commit.disabled).toBe(false)
  })

  it('renders no notice when generation succeeds', () => {
    render(
      <CommitComposer
        message="feat: generated subject"
        onMessageChange={() => {}}
        busy={false}
        hasRemote
        onCommit={() => {}}
      />
    )

    expect(screen.queryByText(/Generation unavailable:/)).toBeNull()
  })
})
