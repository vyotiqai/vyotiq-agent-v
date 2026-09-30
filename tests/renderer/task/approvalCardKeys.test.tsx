/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard } from '@renderer/features/task/record/ApprovalCard'

afterEach(() => {
  cleanup()
  window.vyotiq = undefined as unknown as typeof window.vyotiq
})

const approval = {
  requestId: 'req-1',
  toolName: 'edit',
  summary: 'a.ts',
  argsPreview: '{"path":"a.ts"}',
  mutating: true
}

describe('ApprovalCard keys', () => {
  it('allows with Alt A and denies with Alt D, by the physical key — Option+A types "å" on macOS', () => {
    window.vyotiq = { platform: 'darwin' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn()
    const view = render(<ApprovalCard approval={approval} requestedAt={null} onDecide={onDecide} />)
    // The label a macOS reader sees.
    expect(screen.getByRole('button', { name: 'Allow once' }).getAttribute('title')).toBe('Allow once (⌥A)')
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', altKey: true })
    expect(onDecide).toHaveBeenCalledWith('req-1', 'once')

    view.unmount()
    const onDeny = vi.fn()
    render(<ApprovalCard approval={{ ...approval, requestId: 'req-2' }} requestedAt={null} onDecide={onDeny} />)
    fireEvent.keyDown(window, { key: '∂', code: 'KeyD', altKey: true })
    expect(onDeny).toHaveBeenCalledWith('req-2', 'deny')
  })

  it('says Alt+A on Windows and Linux', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    render(<ApprovalCard approval={approval} requestedAt={null} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Allow once' }).getAttribute('title')).toBe('Allow once (Alt+A)')
  })
})

describe('ApprovalCard focus', () => {
  it('focuses Allow once when it arrives, and not again on a re-render', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const view = render(<ApprovalCard approval={approval} requestedAt={null} onDecide={vi.fn()} />)
    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(document.activeElement).toBe(allow)
    allow.blur()
    // A parent re-render hands a new onDecide: that is not a new request.
    view.rerender(<ApprovalCard approval={approval} requestedAt={null} onDecide={vi.fn()} />)
    expect(document.activeElement).not.toBe(allow)
  })

  it('never takes focus from text being typed elsewhere — the next space would press Allow', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    // jsdom has no isContentEditable; a textarea stands in for the line's field.
    const line = document.createElement('textarea')
    document.body.appendChild(line)
    line.focus()
    try {
      render(<ApprovalCard approval={approval} requestedAt={null} onDecide={vi.fn()} />)
      expect(document.activeElement).toBe(line)
    } finally {
      line.remove()
    }
  })
})

describe('ApprovalCard Always allow', () => {
  const terminal = {
    requestId: 'req-t',
    toolName: 'terminal',
    summary: 'pnpm vitest run a',
    argsPreview: '{"command":"pnpm vitest run a"}',
    mutating: true
  }

  it('names the command it would remember for a terminal call, and sends always', () => {
    const onDecide = vi.fn()
    const { container } = render(
      <div className="@container" style={{ width: 800 }}>
        <ApprovalCard approval={{ ...terminal, alwaysAllowCommand: 'pnpm vitest' }} requestedAt={null} onDecide={onDecide} />
      </div>
    )
    const always = screen.getByRole('button', { name: 'Always allow pnpm vitest' })
    expect(always.getAttribute('title')).toContain('never one that chains or redirects')
    fireEvent.click(always)
    expect(onDecide).toHaveBeenCalledWith('req-t', 'always')
    expect(container.textContent).not.toContain('Always allow terminal')
  })

  it('offers no Always allow for a command that cannot be scoped', () => {
    render(<ApprovalCard approval={{ ...terminal, alwaysAllowCommand: null }} requestedAt={null} onDecide={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Always allow/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow for this task' })).toBeTruthy()
  })

  it('names the tool for anything else', () => {
    render(<ApprovalCard approval={approval} requestedAt={null} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Always allow edit' })).toBeTruthy()
  })
})

describe('ApprovalCard command guard', () => {
  const command = {
    requestId: 'req-g',
    toolName: 'terminal',
    summary: 'rm -rf ~',
    argsPreview: '{"command":"rm -rf ~"}',
    mutating: true,
    alwaysAllowCommand: 'rm'
  }

  it('says what a guarded command would do, with an icon, and offers only Allow once and Deny', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const onDecide = vi.fn()
    render(
      <ApprovalCard
        approval={{ ...command, alwaysAllowCommand: null, danger: 'Deletes ~, outside the workspace, recursively' }}
        requestedAt={null}
        onDecide={onDecide}
      />
    )
    const line = document.querySelector('[data-approval-danger]')!
    expect(line.textContent).toBe('Deletes ~, outside the workspace, recursively. Asks whatever the approval settings say.')
    // Meaning never rides on hue alone: the warning glyph sits beside the words.
    expect(line.querySelector('svg')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow for this task' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onDecide).toHaveBeenCalledWith('req-g', 'once')
  })

  it('keeps every choice for an ordinary command', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    render(<ApprovalCard approval={command} requestedAt={null} onDecide={vi.fn()} />)
    expect(document.querySelector('[data-approval-danger]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow for this task' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Always allow/ })).toBeTruthy()
  })
})
