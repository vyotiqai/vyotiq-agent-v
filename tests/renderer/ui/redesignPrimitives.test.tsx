/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Button,
  IconButton,
  Keys,
  ProgressBar,
  Ring,
  Segmented,
  StatusGlyph,
  STATE_LABEL,
  Tabs,
  type TaskState
} from '@renderer/lib/ui'

afterEach(cleanup)

// cn() has no tailwind-merge: two sizes or two tones on one element means the
// stylesheet's emission order picks the winner. Each test pins that exactly one
// of a mutually exclusive set is present.

describe('Button', () => {
  it('is outlined by default and filled only when primary', () => {
    const { rerender } = render(<Button>Save</Button>)
    expect(screen.getByRole('button').className).toContain('border-border')
    expect(screen.getByRole('button').className).not.toContain('bg-accent')
    rerender(<Button variant="primary">Save</Button>)
    expect(screen.getByRole('button').className).toContain('bg-accent')
  })

  it('emits one geometry: a size, or the legacy control height — never both', () => {
    const { rerender } = render(<Button size="xs">Go</Button>)
    const sized = screen.getByRole('button').className
    expect(sized).toContain('h-6')
    expect(sized).not.toContain('min-h-[var(--vy-control-min-h)]')
    rerender(<Button>Go</Button>)
    const legacy = screen.getByRole('button').className
    expect(legacy).toContain('min-h-[var(--vy-control-min-h)]')
    expect(legacy).not.toMatch(/\bh-(6|7|8)\b/)
  })

  it('shows its shortcut as keycaps, except on a primary button', () => {
    const { container, rerender } = render(<Button kbd={['Ctrl', 'K']}>Open</Button>)
    expect(container.querySelectorAll('kbd')).toHaveLength(2)
    rerender(
      <Button variant="primary" kbd={['Ctrl', 'K']}>
        Open
      </Button>
    )
    expect(container.querySelectorAll('kbd')).toHaveLength(0)
  })
})

describe('IconButton', () => {
  it('uses one tone at a time', () => {
    const { rerender } = render(<IconButton icon="close" label="Dismiss" tone="muted" />)
    let cls = screen.getByRole('button', { name: 'Dismiss' }).className
    expect(cls).toContain('text-tertiary')
    expect(cls).not.toContain('text-secondary')
    rerender(<IconButton icon="close" label="Dismiss" />)
    cls = screen.getByRole('button', { name: 'Dismiss' }).className
    expect(cls).toContain('text-secondary')
    expect(cls).not.toContain('text-tertiary')
  })

  it('replaces the tone with the selected fill when active, and says so', () => {
    render(<IconButton icon="sidebar" label="Navigator" tone="muted" active />)
    const button = screen.getByRole('button', { name: 'Navigator' })
    expect(button.className).toContain('bg-surface-2')
    expect(button.className).not.toContain('text-tertiary')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a focus ring', () => {
    render(<IconButton icon="more" label="More" />)
    expect(screen.getByRole('button', { name: 'More' }).className).toContain('focus-visible:vy-focus-ring')
  })
})

describe('StatusGlyph', () => {
  it('names every state when it stands alone, so hue never carries it', () => {
    for (const state of Object.keys(STATE_LABEL) as TaskState[]) {
      cleanup()
      render(<StatusGlyph state={state} label />)
      expect(screen.getByRole('img', { name: STATE_LABEL[state] })).toBeTruthy()
    }
  })

  it('is hidden from assistive tech when a word sits beside it', () => {
    const { container } = render(<StatusGlyph state="needs" />)
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('Tabs and Segmented', () => {
  const items = [
    { id: 'changes', label: 'Changes' },
    { id: 'files', label: 'Files' },
    { id: 'terminal', label: 'Terminal' }
  ] as const

  it('moves with the arrow keys and wraps', () => {
    const onChange = vi.fn()
    render(<Tabs items={items} value="changes" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Changes' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('terminal')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Changes' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('files')
  })

  it('keeps only the current tab in the tab order', () => {
    render(<Tabs items={items} value="files" />)
    expect(screen.getByRole('tab', { name: 'Files' }).tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: 'Changes' }).tabIndex).toBe(-1)
  })

  it('exposes a segmented control as a radio group', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        label="Diff layout"
        items={[
          { id: 'unified', label: 'Unified' },
          { id: 'split', label: 'Split' }
        ]}
        value="unified"
        onChange={onChange}
      />
    )
    expect(screen.getByRole('radio', { name: 'Unified' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }))
    expect(onChange).toHaveBeenCalledWith('split')
  })
})

describe('Progress', () => {
  it('clamps the bar and guards a zero max', () => {
    const { rerender } = render(<ProgressBar value={12} max={10} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    rerender(<ProgressBar value={3} max={0} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('warns at 70% and turns danger at 90%, one tone at a time', () => {
    const tone = (v: number) => {
      cleanup()
      const { container } = render(<Ring value={v} />)
      return container.querySelector('svg')?.getAttribute('class') ?? ''
    }
    expect(tone(0.5)).toContain('text-fg')
    expect(tone(0.75)).toContain('text-warning')
    expect(tone(0.95)).toContain('text-danger')
    expect(tone(0.95)).not.toContain('text-warning')
  })
})

describe('Keys', () => {
  it('renders a chord as one keycap per key', () => {
    const { container } = render(<Keys keys={['Ctrl', 'Shift', 'I']} />)
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Shift', 'I'])
  })
})
