/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { ChatPaneHost } from '@renderer/features/chat/ChatPaneHost'
import {
  markSessionDragEnd,
  markSessionDragStart,
  SESSION_DRAG_MIME
} from '@renderer/lib/chat/chatPaneLayout'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'

const pane: ChatPane = {
  paneId: 'pane-1',
  workspacePath: '/ws/a',
  runId: 'run-a'
}

function mockPaneRect(host: HTMLElement): void {
  Object.defineProperty(host, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 400,
      right: 600,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })
}

function dropAt(host: HTMLElement, clientX: number, payload: string): void {
  const event = createEvent.drop(host, {
    dataTransfer: {
      types: [SESSION_DRAG_MIME],
      getData: (type: string) => (type === SESSION_DRAG_MIME ? payload : '')
    }
  })
  Object.defineProperty(event, 'clientX', { configurable: true, value: clientX })
  fireEvent(host, event)
}

describe('ChatPaneHost drop', () => {
  it('labels each pane and hands it close and split — the pane draws its own header', () => {
    const onClosePane = vi.fn()
    const onSplitPane = vi.fn()
    const panes: ChatPane[] = [
      pane,
      { paneId: 'pane-2', workspacePath: '/ws/a', runId: null }
    ]
    render(
      <ChatPaneHost
        panes={panes}
        focusedPaneId="pane-1"
        sizes={[0.5, 0.5]}
        sideRailPad
        onFocusPane={() => {}}
        onClosePane={onClosePane}
        onSplitPane={onSplitPane}
        onSizesChange={() => {}}
        onSessionDrop={() => true}
        getPaneTitle={(p) => (p.runId ? 'Chat A' : 'New task')}
        renderPane={(p, opts) => (
          <div data-testid="pane-body" data-rail={opts.sideRailPad ? '1' : '0'} data-multi={opts.multi ? '1' : '0'}>
            <button type="button" onClick={opts.onClose}>
              Close {p.paneId}
            </button>
            <button type="button" onClick={opts.onSplit}>
              Split {p.paneId}
            </button>
          </div>
        )}
      />
    )

    // No second header above the pane: its region is named, its body is the header.
    expect(document.querySelectorAll('[data-chat-pane-header]')).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Chat A' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'New task' })).toBeTruthy()

    const shells = document.querySelectorAll('[data-chat-pane-shell]')
    expect(shells).toHaveLength(2)
    for (const shell of shells) {
      expect((shell as HTMLElement).style.minWidth).toBe('280px')
    }

    const bodies = screen.getAllByTestId('pane-body')
    expect(bodies.map((b) => b.getAttribute('data-multi'))).toEqual(['1', '1'])
    expect(bodies[0]!.getAttribute('data-rail')).toBe('0')
    expect(bodies[1]!.getAttribute('data-rail')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: 'Close pane-2' }))
    expect(onClosePane).toHaveBeenCalledWith('pane-2')
    fireEvent.click(screen.getByRole('button', { name: 'Split pane-1' }))
    expect(onSplitPane).toHaveBeenCalledTimes(1)
  })

  it('offers no close to a lone pane', () => {
    let seen: { multi: boolean; onClose?: () => void } | null = null
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={() => true}
        getPaneTitle={() => 'Chat A'}
        renderPane={(_p, opts) => {
          seen = { multi: opts.multi, onClose: opts.onClose }
          return <div data-testid="pane-body">body</div>
        }}
      />
    )
    expect(seen).toEqual({ multi: false, onClose: undefined })
  })

  it('splits on left-third drop', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)
    dropAt(host, 80, JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' }))

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'left', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })

  it('splits on right-third drop instead of replacing', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)
    dropAt(host, 520, JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' }))

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'right', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })

  it('replaces only on middle-third drop', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)
    dropAt(host, 300, JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' }))

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'center', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })

  it('accepts dragover with text/plain while a session drag is active', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)
    markSessionDragStart()
    const dragOver = createEvent.dragOver(host, {
      dataTransfer: { types: ['text/plain'] }
    })
    Object.defineProperty(dragOver, 'clientX', { configurable: true, value: 520 })
    fireEvent(host, dragOver)
    markSessionDragEnd()

    const drop = createEvent.drop(host, {
      dataTransfer: {
        types: ['text/plain'],
        getData: (type: string) =>
          type === 'text/plain'
            ? JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' })
            : ''
      }
    })
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 520 })
    // Drop lands while the session drag is still active — dragend fires after drop.
    markSessionDragStart()
    fireEvent(host, drop)
    markSessionDragEnd()

    expect(onSessionDrop).toHaveBeenCalledWith('pane-1', 'right', {
      workspacePath: '/ws/b',
      runId: 'run-b'
    })
  })

  it('drop of an unparsable session payload no-ops with dropEffect none and clears highlight', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)

    // Park the highlight first so the drop must clear it.
    markSessionDragStart()
    const dragOver = createEvent.dragOver(host, {
      dataTransfer: { types: ['text/plain'] }
    })
    Object.defineProperty(dragOver, 'clientX', { configurable: true, value: 520 })
    fireEvent(host, dragOver)
    expect(
      (host as HTMLElement).querySelector('div[aria-hidden="true"]')
    ).toBeTruthy()

    const drop = createEvent.drop(host, {
      dataTransfer: {
        types: [SESSION_DRAG_MIME],
        getData: (type: string) => (type === SESSION_DRAG_MIME ? 'not-json' : '')
      }
    })
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 520 })
    const dataTransfer = (drop as unknown as DragEvent).dataTransfer as DataTransfer
    fireEvent(host, drop)
    markSessionDragEnd()

    expect(onSessionDrop).not.toHaveBeenCalled()
    expect(dataTransfer.dropEffect).toBe('none')
    expect(
      (host as HTMLElement).querySelector('div[aria-hidden="true"]')
    ).toBeFalsy()
  })

  it('drop of a foreign drag bails without preventDefault or onSessionDrop', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)

    const drop = createEvent.drop(host, {
      dataTransfer: {
        types: ['text/plain'],
        getData: (type: string) =>
          type === 'text/plain'
            ? JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' })
            : ''
      }
    })
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 520 })
    const preventDefault = vi.fn()
    ;(drop as unknown as { preventDefault: () => void }).preventDefault = preventDefault
    fireEvent(host, drop)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(onSessionDrop).not.toHaveBeenCalled()
    expect(
      (host as HTMLElement).querySelector('div[aria-hidden="true"]')
    ).toBeFalsy()
  })

  it('dragover of a foreign drag shows no highlight and claims nothing', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)

    const dragOver = createEvent.dragOver(host, {
      dataTransfer: { types: ['text/plain'] }
    })
    Object.defineProperty(dragOver, 'clientX', { configurable: true, value: 520 })
    const preventDefault = vi.fn()
    ;(dragOver as unknown as { preventDefault: () => void }).preventDefault =
      preventDefault
    fireEvent(host, dragOver)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(
      (host as HTMLElement).querySelector('div[aria-hidden="true"]')
    ).toBeFalsy()
  })

  it('valid session drop claims the event once and stops propagation', () => {
    const onSessionDrop = vi.fn(() => true)
    render(
      <ChatPaneHost
        panes={[pane]}
        focusedPaneId="pane-1"
        sizes={[1]}
        onFocusPane={() => {}}
        onClosePane={() => {}}
        onSizesChange={() => {}}
        onSessionDrop={onSessionDrop}
        getPaneTitle={() => 'Chat A'}
        renderPane={() => <div data-testid="pane-body">body</div>}
      />
    )

    const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
    mockPaneRect(host)

    const drop = createEvent.drop(host, {
      dataTransfer: {
        types: [SESSION_DRAG_MIME],
        getData: (type: string) =>
          type === SESSION_DRAG_MIME
            ? JSON.stringify({ workspacePath: '/ws/b', runId: 'run-b' })
            : ''
      }
    })
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 520 })
    const stopPropagation = vi.fn()
    ;(drop as unknown as { stopPropagation: () => void }).stopPropagation =
      stopPropagation
    fireEvent(host, drop)

    expect(onSessionDrop).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(
      (host as HTMLElement).querySelector('div[aria-hidden="true"]')
    ).toBeFalsy()
  })
})
