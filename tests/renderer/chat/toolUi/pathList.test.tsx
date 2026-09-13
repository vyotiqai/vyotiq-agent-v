/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PathList, MatchList, DirListing } from '@renderer/features/chat/toolUi/primitives'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

afterEach(() => {
  cleanup()
})

describe('PathList', () => {
  it('opens a workspace file on click when a session workspace is set', () => {
    const openFile = vi.fn()
    render(
      <RunSessionProvider
        value={{ workspacePath: '/ws/demo', runId: 'run-1', onOpenWorkspaceFile: openFile }}
      >
        <PathList paths={['src/app.ts']} />
      </RunSessionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'src/app.ts' }))
    expect(openFile).toHaveBeenCalledWith('src/app.ts')
  })

  it('stays text without a workspace open handler', () => {
    render(<PathList paths={['src/app.ts']} />)
    expect(screen.queryByRole('button', { name: 'src/app.ts' })).toBeNull()
    expect(screen.getByText('src/app.ts')).toBeTruthy()
  })
})

describe('MatchList', () => {
  it('opens the match file from the header', () => {
    const openFile = vi.fn()
    render(
      <RunSessionProvider
        value={{ workspacePath: '/ws/demo', runId: 'run-1', onOpenWorkspaceFile: openFile }}
      >
        <MatchList
          groups={[{ file: 'src/app.ts', matches: [{ line: 4, text: 'hello', isMatch: true }] }]}
        />
      </RunSessionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'src/app.ts' }))
    expect(openFile).toHaveBeenCalledWith('src/app.ts')
  })

  it('opens the match file at the clicked line number', () => {
    const openFile = vi.fn()
    render(
      <RunSessionProvider
        value={{ workspacePath: '/ws/demo', runId: 'run-1', onOpenWorkspaceFile: openFile }}
      >
        <MatchList
          groups={[{ file: 'src/app.ts', matches: [{ line: 4, text: 'hello', isMatch: true }] }]}
        />
      </RunSessionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(openFile).toHaveBeenCalledWith('src/app.ts', { line: 4 })
  })
})

describe('DirListing', () => {
  it('opens a joined workspace path when basePath and session workspace are set', () => {
    const openFile = vi.fn()
    render(
      <RunSessionProvider
        value={{ workspacePath: '/ws/demo', runId: 'run-1', onOpenWorkspaceFile: openFile }}
      >
        <DirListing
          basePath="src"
          entries={[{ kind: 'file', name: 'index.ts', size: '2K' }]}
        />
      </RunSessionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'index.ts' }))
    expect(openFile).toHaveBeenCalledWith('src/index.ts')
  })

  it('stays text without a workspace open handler', () => {
    render(
      <DirListing basePath="src" entries={[{ kind: 'file', name: 'index.ts', size: '' }]} />
    )
    expect(screen.queryByRole('button', { name: 'index.ts' })).toBeNull()
    expect(screen.getByText('index.ts')).toBeTruthy()
  })
})
