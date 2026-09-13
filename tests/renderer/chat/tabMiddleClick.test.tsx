/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  AGENT_DOCK_TAB,
  DockTabBar,
  type DockTabItem
} from '@renderer/features/chat/components/DockTabBar'
import { TerminalSessionBar } from '@renderer/features/chat/components/TerminalSessionBar'
import type { PtySessionInfo } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const terminalTab: DockTabItem = { id: 'terminal', label: 'Terminal', icon: 'terminal' }

function tabShell(name: string): HTMLElement {
  const tab = screen.getByRole('tab', { name })
  const shell = tab.parentElement
  if (!(shell instanceof HTMLElement)) throw new Error(`tab shell missing for ${name}`)
  return shell
}

function auxClick(el: HTMLElement, button: number): void {
  el.dispatchEvent(
    new MouseEvent('auxclick', { button, bubbles: true, cancelable: true })
  )
}

describe('middle-click tab close', () => {
  it('closes a closable dock panel tab on auxclick button 1', () => {
    const onCloseTab = vi.fn()
    render(
      <DockTabBar
        active="agent"
        tabs={[AGENT_DOCK_TAB, terminalTab]}
        onSelect={() => {}}
        onCloseTab={onCloseTab}
        onOpenPanel={() => {}}
      />
    )
    auxClick(tabShell('Terminal'), 1)
    expect(onCloseTab).toHaveBeenCalledWith('terminal')
  })

  it('never closes the Agent dock tab and ignores non-middle buttons', () => {
    const onCloseTab = vi.fn()
    render(
      <DockTabBar
        active="agent"
        tabs={[AGENT_DOCK_TAB, terminalTab]}
        onSelect={() => {}}
        onCloseTab={onCloseTab}
        onOpenPanel={() => {}}
      />
    )
    auxClick(tabShell('Agent'), 1)
    expect(onCloseTab).not.toHaveBeenCalled()
    auxClick(tabShell('Terminal'), 0)
    expect(onCloseTab).not.toHaveBeenCalled()
  })

  it('swallows middle-button mousedown (autoscroll) on dock tabs', () => {
    render(
      <DockTabBar
        active="terminal"
        tabs={[terminalTab]}
        onSelect={() => {}}
        onCloseTab={() => {}}
        onOpenPanel={() => {}}
      />
    )
    const shell = tabShell('Terminal')
    const event = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })
    shell.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('kills a terminal session tab on middle-click', () => {
    const onKill = vi.fn()
    const session: PtySessionInfo = {
      id: 'sess-1',
      title: 'cmd',
      cwd: '/ws',
      running: true,
      backend: 'pty'
    }
    render(
      <TerminalSessionBar
        sessions={[session]}
        activeId="sess-1"
        splitId={null}
        onSelect={() => {}}
        onKill={onKill}
        onCreate={() => {}}
        onToggleSplit={() => {}}
      />
    )
    auxClick(tabShell('cmd'), 1)
    expect(onKill).toHaveBeenCalledWith('sess-1')
  })
})
