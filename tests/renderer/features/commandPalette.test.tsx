/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette } from '@renderer/features/commandPalette/CommandPalette'

afterEach(() => cleanup())

const twoWorkspaces = [
  { name: 'alpha', current: false },
  { name: 'vyotiq', current: true }
]

describe('CommandPalette', () => {
  it('shows one switch and one new-chat entry per open workspace, with no dead slots', () => {
    render(
      <CommandPalette open onClose={() => {}} onSelect={vi.fn()} workspaces={twoWorkspaces} />
    )

    expect(screen.getByText('Switch to workspace 1: alpha')).not.toBeNull()
    expect(screen.getByText('Switch to workspace 2: vyotiq — current')).not.toBeNull()
    expect(screen.getByText('New chat in alpha')).not.toBeNull()
    expect(screen.getByText('New chat in vyotiq')).not.toBeNull()
    expect(screen.queryByText(/^Switch to workspace 3/)).toBeNull()
    expect(screen.queryByText(/^Switch to workspace 9/)).toBeNull()
  })

  it('emits workspaceN and newchatN ids on click', () => {
    const onSelect = vi.fn()
    render(
      <CommandPalette open onClose={() => {}} onSelect={onSelect} workspaces={twoWorkspaces} />
    )

    fireEvent.click(screen.getByText('New chat in alpha'))
    fireEvent.click(screen.getByText('Switch to workspace 2: vyotiq — current'))
    expect(onSelect).toHaveBeenNthCalledWith(1, 'newchat1')
    expect(onSelect).toHaveBeenNthCalledWith(2, 'workspace2')
  })

  it('filters by workspace name and runs the highlighted entry on Enter', () => {
    const onSelect = vi.fn()
    render(
      <CommandPalette open onClose={() => {}} onSelect={onSelect} workspaces={twoWorkspaces} />
    )

    const input = screen.getByPlaceholderText('Search commands…')
    fireEvent.change(input, { target: { value: 'vyotiq' } })
    expect(screen.queryByText('Switch to workspace 1: alpha')).toBeNull()
    expect(screen.getByText('Switch to workspace 2: vyotiq — current')).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('workspace2')
  })

  it('keeps the generic catalog when no workspaces prop is provided', () => {
    render(<CommandPalette open onClose={() => {}} onSelect={vi.fn()} />)

    expect(screen.getByText('Switch to workspace 1')).not.toBeNull()
    expect(screen.getByText('Switch to workspace 9')).not.toBeNull()
    expect(screen.queryByText(/^New chat in /)).toBeNull()
  })
})
