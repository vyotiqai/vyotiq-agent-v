/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'

afterEach(() => cleanup())

function Probe({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose, true, { deferToMenus: true })
  return <input aria-label="probe" />
}

describe('useEscapeToClose', () => {
  it('is how the instance pane closes, and skips inputs', () => {
    const paneSrc = readFileSync(
      join(process.cwd(), 'src/renderer/src/features/chat/components/AgentInstancePane.tsx'),
      'utf8'
    )
    expect(paneSrc).toContain('useEscapeToClose(onClose, true, { deferToMenus: true })')

    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.keyDown(screen.getByLabelText('probe'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
