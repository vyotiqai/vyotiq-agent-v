/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import {
  estimateTranscriptRowSize,
  MessageList,
  transcriptRowsContentRevision
} from '@renderer/features/chat/components/MessageList'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import {
  TOOL_BODY_CLAMP_PX,
  TOOL_GROUP_LIST_ESTIMATE_MIN_PX,
  TOOL_TERMINAL_VIEWPORT_MAX_PX
} from '@renderer/lib/utils/layout'
import type { UiItem } from '@shared/transcript'
import { toolGroup } from './helpers/testGroups'
import { emptyStepUsageTotals } from '@shared/utils/runTelemetry'

function visibleTextMatches(pattern: RegExp): HTMLElement[] {
  return screen
    .getAllByText(pattern)
    .filter((element) => !element.closest('[data-live-receipt-announcement]'))
}

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
})

describe('MessageList', () => {
  it('shows live TurnSummary Compacting… while the run is compacting', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'working' }
    ]

    render(<MessageList items={items} running compacting />)

    expect(screen.getByText('Compacting…')).toBeTruthy()
    expect(document.querySelector('[data-compact-status]')).toBeNull()
    expect(screen.queryByText(/Context summarised/)).toBeNull()
  })

  it('keeps Compacting… on the live TurnSummary when tool chrome is visible', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'src/auth.ts', status: 'running' }
      }
    ]

    render(<MessageList items={items} running compacting />)

    expect(screen.getByText('Compacting…')).toBeTruthy()
  })

  it('shows idle Compacting… inline in the transcript (not under the composer)', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'done' }
    ]

    render(<MessageList items={items} compacting />)

    const status = document.querySelector('[data-compact-status]')
    expect(status?.textContent).toContain('Compacting…')
  })

  it('shows the compaction summary in the transcript after compact completes', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Earlier turns set up auth and the session store.',
        tokenEstimate: 1200,
        verifyStatus: 'verified',
        verifyCoverage: 1
      }
    ]

    render(<MessageList items={items} />)

    expect(document.querySelector('[data-compact-status]')).toBeNull()
    expect(screen.getByText('Context summarised')).toBeTruthy()
    expect(screen.getByText('Verified 100%')).toBeTruthy()
    expect(screen.getByText('~1.2k')).toBeTruthy()
    expect(screen.getByText('Earlier turns set up auth and the session store.')).toBeTruthy()
  })

  it('shows a failed compact card with the verify reason', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Forgot the decision.',
        verifyStatus: 'failed',
        verifyFailures: ['Missing decision: Use JWT']
      }
    ]

    render(<MessageList items={items} />)

    expect(screen.getByText('Summary not applied')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Missing decision: Use JWT')).toBeTruthy()
  })
})
