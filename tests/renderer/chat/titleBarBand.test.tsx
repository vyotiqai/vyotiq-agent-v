/**
 * @vitest-environment jsdom
 *
 * The TitleBar is an absolute overlay across the top of the main column: a
 * window-drag region on the left, the caption buttons on the right. Chat chrome
 * pinned to the top of a pane lands inside that band, and used to lose to it
 * twice over — the instance header's meter and Stop were painted under
 * minimize/maximize, and the whole row was dead to the mouse because a drag
 * region swallows clicks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useLayoutEffect, type ReactElement, type ReactNode } from 'react'
import { AgentInstancePane } from '@renderer/features/chat/components/AgentInstancePane'
import { ChatPaneHost } from '@renderer/features/chat/ChatPaneHost'
import { TitleBar } from '@renderer/app/TitleBar'
import { BreakpointProvider } from '@renderer/lib/context/BreakpointProvider'
import {
  TitleBarAccessoryProvider,
  TitleBarBandSpent,
  useTitleBarAccessory
} from '@renderer/lib/context/TitleBarAccessory'
import { ChatTranscriptStage } from '@renderer/features/chat/components/ChatTranscriptStage'
import {
  CHAT_STAGE_TOP_BAND_INSET,
  WINDOW_CONTROLS_WIDTH_PX
} from '@renderer/lib/utils/layout'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('1024px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  window.vyotiq = {
    platform: 'win32',
    windowIsMaximized: vi.fn(async () => ({ ok: true as const, data: false }))
  } as unknown as typeof window.vyotiq
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Mirrors the shell: TitleBar overlay plus the main column beneath it. */
function Shell({
  children,
  occupied = false
}: {
  children: ReactNode
  occupied?: boolean
}): ReactElement {
  return (
    <BreakpointProvider>
      <TitleBarAccessoryProvider>
        <Occupancy occupied={occupied} />
        <TitleBar drawerOpen={false} onToggleSidebar={vi.fn()} />
        {children}
      </TitleBarAccessoryProvider>
    </BreakpointProvider>
  )
}

/** Stands in for ChatView reporting that dock tabs took the accessory slot. */
function Occupancy({ occupied }: { occupied: boolean }): null {
  const { setOccupied } = useTitleBarAccessory()
  useLayoutEffect(() => {
    setOccupied(occupied)
  }, [occupied, setOccupied])
  return null
}

function instanceHeader(): HTMLElement {
  const header = document.querySelector('[data-instance-header]')
  if (!header) throw new Error('instance header not found')
  return header as HTMLElement
}

describe('instance pane header inside the title-bar band', () => {
  it('matches the band height and holds the caption strip open', () => {
    render(
      <Shell>
        <AgentInstancePane workspacePath="/ws" instanceRunId="band-1" onClose={() => {}} />
      </Shell>
    )
    const header = instanceHeader()
    expect(header.className).toContain('h-9')
    expect(header.className).not.toContain('h-7')
    expect(header.style.paddingRight).toBe(`${WINDOW_CONTROLS_WIDTH_PX}px`)
  })

  it('leaves its controls clickable and keeps a drag handle for the window', () => {
    render(
      <Shell>
        <AgentInstancePane workspacePath="/ws" instanceRunId="band-2" onClose={() => {}} />
      </Shell>
    )
    const back = screen.getByRole('button', { name: 'Back to parent chat' })
    expect(back.className).toContain('app-region-no-drag')
    // The bar gave up its drag region for this band, so the header's inert
    // title has to give the window somewhere to be dragged from.
    const title = instanceHeader().querySelector('[title]') as HTMLElement
    expect(title.className).toContain('app-region-drag')
  })

  it('hands the band back to the main column, both hit tests', () => {
    render(
      <Shell>
        <AgentInstancePane workspacePath="/ws" instanceRunId="band-3" onClose={() => {}} />
      </Shell>
    )
    const bar = document.querySelector('[data-titlebar]') as HTMLElement
    // The DOM one: the bar is stacked over <main>, so it must stop answering
    // for points in the band. A nested `no-drag` does nothing about this.
    expect(bar.className).toContain('pointer-events-none')
    // Electron's: the drag region is resolved at the window level, so the bar
    // drops it outright rather than trusting a nested subtraction.
    expect(bar.className).not.toContain('app-region-drag')
    // The window's own buttons opt back in.
    const controls = document.querySelector('[data-titlebar-controls]') as HTMLElement
    expect(controls.className).toContain('pointer-events-auto')
    expect(document.querySelector('[data-titlebar-band-released]')).toBeTruthy()
  })

  it('reserves nothing on macOS, where the caption buttons are not in this corner', () => {
    window.vyotiq = {
      platform: 'darwin',
      windowIsMaximized: vi.fn(async () => ({ ok: true as const, data: false }))
    } as unknown as typeof window.vyotiq
    render(
      <Shell>
        <AgentInstancePane workspacePath="/ws" instanceRunId="band-4" onClose={() => {}} />
      </Shell>
    )
    expect(instanceHeader().style.paddingRight).toBe('')
  })
})

describe('instance pane header below the band', () => {
  it('is an ordinary row once dock tabs occupy the band', () => {
    render(
      <Shell occupied>
        <AgentInstancePane workspacePath="/ws" instanceRunId="below-1" onClose={() => {}} />
      </Shell>
    )
    const header = instanceHeader()
    expect(header.className).toContain('h-7')
    expect(header.style.paddingRight).toBe('')
  })

  it('is an ordinary row once a pane header above it spent the band', () => {
    render(
      <Shell>
        <TitleBarBandSpent>
          <AgentInstancePane workspacePath="/ws" instanceRunId="below-2" onClose={() => {}} />
        </TitleBarBandSpent>
      </Shell>
    )
    const header = instanceHeader()
    expect(header.className).toContain('h-7')
    expect(header.style.paddingRight).toBe('')
  })

  it('does not claim the band, so the TitleBar keeps its drag region', () => {
    render(
      <Shell>
        <TitleBarBandSpent>
          <AgentInstancePane workspacePath="/ws" instanceRunId="below-3" onClose={() => {}} />
        </TitleBarBandSpent>
      </Shell>
    )
    const bar = document.querySelector('[data-titlebar]') as HTMLElement
    expect(bar.className).toContain('app-region-drag')
    expect(bar.className).not.toContain('pointer-events-none')
    expect(document.querySelector('[data-titlebar-band-released]')).toBeNull()
  })
})

function pane(id: string): ChatPane {
  return { paneId: id, workspacePath: '/ws', runId: null } as ChatPane
}

function renderPaneHost(panes: ChatPane[]) {
  return render(
    <Shell>
      <ChatPaneHost
        panes={panes}
        focusedPaneId={panes[0]!.paneId}
        sizes={panes.map(() => 1 / panes.length)}
        sideRailPad
        onFocusPane={vi.fn()}
        onClosePane={vi.fn()}
        onSizesChange={vi.fn()}
        onSessionDrop={vi.fn(() => true)}
        getPaneTitle={(p) => `Pane ${p.paneId}`}
        renderPane={() => <div data-pane-body />}
      />
    </Shell>
  )
}

describe('multi-pane headers inside the band', () => {
  it('ends before the caption buttons on the rightmost pane only', () => {
    renderPaneHost([pane('a'), pane('b')])
    const headers = Array.from(
      document.querySelectorAll('[data-chat-pane-header]')
    ) as HTMLElement[]
    expect(headers).toHaveLength(2)
    // The edge moves, not the padding: an `inset-x-0` header padded on the
    // right still lies across the caption buttons and swallows their clicks.
    expect(headers[0]!.style.right).toBe('')
    expect(headers[1]!.style.right).toBe(`${WINDOW_CONTROLS_WIDTH_PX}px`)
    for (const header of headers) expect(header.className).toContain('h-9')
  })

  it('keeps Close clickable and offsets the pane body by the band', () => {
    renderPaneHost([pane('a'), pane('b')])
    const close = screen.getAllByRole('button', { name: /^Close Pane/ })[0]!
    expect(close.className).toContain('app-region-no-drag')
    const body = document.querySelector('[data-pane-body]')!.parentElement!
    expect(body.className).toContain('pt-9')
  })

  it('draws no header for a single pane, and leaves the band to its content', () => {
    renderPaneHost([pane('solo')])
    expect(document.querySelector('[data-chat-pane-header]')).toBeNull()
    expect(document.querySelector('[data-titlebar-band-released]')).toBeNull()
  })
})

describe('pending-gate banner and the band', () => {
  const gates = [{ runId: 'gate-1', kind: 'approval' as const }]

  function renderStage(spent: boolean) {
    const stage = (
      <ChatTranscriptStage
        pendingGates={gates}
        onOpenInstance={vi.fn()}
        transcript={<div data-transcript />}
      />
    )
    return render(<Shell>{spent ? <TitleBarBandSpent>{stage}</TitleBarBandSpent> : stage}</Shell>)
  }

  /** The gate banner is the stage's first row, above the transcript. */
  function bannerRow(): HTMLElement {
    const stage = document.querySelector('[data-chat-stage]')
    if (!stage) throw new Error('stage did not render')
    return stage.firstElementChild as HTMLElement
  }

  it('drops below the band rather than under the caption buttons', () => {
    renderStage(false)
    expect(bannerRow().className).toContain(CHAT_STAGE_TOP_BAND_INSET)
  })

  it('keeps its usual lead-in once chrome above it spent the band', () => {
    renderStage(true)
    expect(bannerRow().className).toContain('pt-2')
    expect(bannerRow().className).not.toContain(CHAT_STAGE_TOP_BAND_INSET)
  })

  it('leaves the TitleBar drag region alone — the transcript still needs it', () => {
    renderStage(false)
    expect(document.querySelector('[data-titlebar-band-released]')).toBeNull()
  })
})
