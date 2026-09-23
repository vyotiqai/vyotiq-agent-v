/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TerminalSessionBar } from '@renderer/features/chat/components/TerminalSessionBar'
import type { PtySessionInfo } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

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
