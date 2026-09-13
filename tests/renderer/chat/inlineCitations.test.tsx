/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import { MessageFooter } from '@renderer/features/chat/components/MessageFooter'
import type { UiItem } from '@shared/transcript'

const FILE = 'src/main/agent/loop.ts'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function turnItems(content: string, extraTools: UiItem[] = []): UiItem[] {
  return [
    { kind: 'message', id: 'u1', role: 'user', content: 'why' },
    {
      kind: 'tool',
      id: 't-read',
      tool: {
        id: 't-read',
        name: 'read',
        summary: 'Read loop.ts',
        status: 'done',
        argsPreview: JSON.stringify({ path: FILE })
      },
      groupTiming: { startedAt: 1, endedAt: 2 }
    },
    ...extraTools,
    { kind: 'message', id: 'a1', role: 'assistant', content }
  ]
}

describe('inline citations in chat', () => {
  it('opens workspace files from inline file links without superscripts or a footer', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <RunSessionProvider
        value={{ workspacePath: 'C:/ws', runId: 'r1', onOpenWorkspaceFile }}
      >
        <MessageList items={turnItems(`It returns early [[${FILE}:42]].`)} />
      </RunSessionProvider>
    )

    expect(screen.queryByText(/\[\[/)).toBeNull()
    expect(screen.queryByLabelText('Sources')).toBeNull()
    const link = screen.getByRole('button', { name: `${FILE}:42` })
    fireEvent.click(link)
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(FILE, { line: 42 })
  })

  it('opens workspace files from inline code filename chips', () => {
    const onOpenWorkspaceFile = vi.fn()
    render(
      <RunSessionProvider
        value={{ workspacePath: 'C:/ws', runId: 'r1', onOpenWorkspaceFile }}
      >
        <MessageList
          items={turnItems(
            '* `AGENTS.md` explicitly defines rules [[AGENTS.md]]\n* `package.json` describes the project [[package.json]]',
            [
              {
                kind: 'tool',
                id: 't-read-agents',
                tool: {
                  id: 't-read-agents',
                  name: 'read',
                  summary: 'Read AGENTS.md',
                  status: 'done',
                  argsPreview: JSON.stringify({ path: 'AGENTS.md' })
                },
                groupTiming: { startedAt: 1, endedAt: 2 }
              },
              {
                kind: 'tool',
                id: 't-read-pkg',
                tool: {
                  id: 't-read-pkg',
                  name: 'read',
                  summary: 'Read package.json',
                  status: 'done',
                  argsPreview: JSON.stringify({ path: 'package.json' })
                },
                groupTiming: { startedAt: 1, endedAt: 2 }
              }
            ]
          )}
        />
      </RunSessionProvider>
    )

    expect(screen.queryByLabelText('Sources')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('AGENTS.md', undefined)
    fireEvent.click(screen.getByRole('button', { name: 'package.json' }))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('package.json', undefined)
  })

  it('renders https URL markers as external links', () => {
    render(
      <MessageList
        items={turnItems('See the docs [[https://example.com/a]].', [
          {
            kind: 'tool',
            id: 't-nav',
            tool: {
              id: 't-nav',
              name: 'browser_navigate',
              summary: 'Opened example.com',
              status: 'done',
              argsPreview: JSON.stringify({ url: 'https://example.com/a' })
            }
          }
        ])}
      />
    )
    const link = screen.getByRole('link', { name: 'example.com/a' })
    expect(link.getAttribute('href')).toContain('example.com/a')
  })

  it('does not show a source footer when nothing resolved', () => {
    render(<MessageList items={turnItems('No evidence in this sentence.')} />)
    expect(screen.queryByLabelText('Sources')).toBeNull()
    expect(screen.getByText('No evidence in this sentence.')).toBeTruthy()
  })

  it('hides an incomplete streaming marker', () => {
    render(
      <MessageList
        items={[
          { kind: 'message', id: 'u1', role: 'user', content: 'why' },
          {
            kind: 'tool',
            id: 't-read',
            tool: {
              id: 't-read',
              name: 'read',
              summary: 'Read loop.ts',
              status: 'done',
              argsPreview: JSON.stringify({ path: FILE })
            },
            groupTiming: { startedAt: 1, endedAt: 2 }
          },
          {
            kind: 'message',
            id: 'a1',
            role: 'assistant',
            content: `Checking [[${FILE}`,
            streaming: true
          }
        ]}
      />
    )
    expect(screen.queryByText(/\[\[/)).toBeNull()
    expect(screen.queryByLabelText('Sources')).toBeNull()
    expect(screen.getByText('Checking')).toBeTruthy()
  })
})

describe('MessageFooter copy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('copies plain paths instead of raw markers or numbered citations', async () => {
    const writeClipboard = vi.fn(() => true)
    vi.stubGlobal('vyotiq', { writeClipboard })
    render(
      <MessageFooter
        content={`Returns early [[${FILE}:42]].`}
        copyContent={`Returns early ${FILE}:42.`}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(writeClipboard).toHaveBeenCalledWith(`Returns early ${FILE}:42.`)
  })
})
