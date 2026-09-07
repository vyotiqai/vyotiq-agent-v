/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IconButton } from '@renderer/lib/ui/IconButton'
import { Button } from '@renderer/lib/ui/Button'
import { Tooltip } from '@renderer/lib/ui/Tooltip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

function tip(): HTMLElement | null {
  return document.body.querySelector('[role="tooltip"]')
}

type Rect = { left: number; top: number; width: number; height: number }

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

describe('Tooltip', () => {
  it('shows content after hover delay', () => {
    render(
      <Tooltip content="Hint text" delayMs={400}>
        <button type="button">Trigger</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Trigger' }))
    expect(tip()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Hint text')
    expect(tip()?.getAttribute('data-opened-by')).toBe('hover')
  })

  it('cancels pending show when Escape is pressed during delay', () => {
    render(
      <Tooltip content="Delayed" delayMs={400}>
        <button type="button">Trigger</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Trigger' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(tip()).toBeNull()
  })

  it('shows content on focus and hides on Escape', () => {
    render(
      <Tooltip content="Focus tip" delayMs={100}>
        <button type="button">Focus me</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Focus me' })
    fireEvent.focus(button)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(tip()?.textContent).toBe('Focus tip')
    expect(tip()?.getAttribute('data-opened-by')).toBe('focus')
    expect(button.getAttribute('aria-describedby')).toBeTruthy()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(tip()).toBeNull()
  })

  it('hides hover tip on Escape without claiming the event', () => {
    render(
      <Tooltip content="Hover tip" delayMs={50}>
        <button type="button">Hover</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Hover' })
    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()

    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => {
      window.dispatchEvent(esc)
    })
    expect(esc.defaultPrevented).toBe(false)
    expect(tip()).toBeNull()
  })

  it('hides on pointer leave', () => {
    render(
      <Tooltip content="Leave tip" delayMs={50}>
        <button type="button">Leave</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Leave' })
    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()

    fireEvent.pointerLeave(button)
    expect(tip()).toBeNull()
  })

  it('keeps a focus-opened tip open when the pointer grazes and leaves', () => {
    render(
      <Tooltip content="Focus stays" delayMs={50}>
        <button type="button">Stay</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Stay' })
    button.focus()
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()
    expect(tip()?.getAttribute('data-opened-by')).toBe('focus')

    // Pointer graze doesn't close a tip the element still holds focus for
    fireEvent.pointerLeave(button)
    expect(tip()).not.toBeNull()

    fireEvent.blur(button)
    expect(tip()).toBeNull()
  })

  it('skips the delay when the previous tip just closed (toolbar scan)', () => {
    render(
      <Tooltip content="Fast" delayMs={400}>
        <button type="button">Fast</button>
      </Tooltip>
    )

    const button = screen.getByRole('button', { name: 'Fast' })
    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(tip()).not.toBeNull()

    fireEvent.pointerLeave(button)
    expect(tip()).toBeNull()

    // Re-enter within the fast-reopen window shows without the full delay
    fireEvent.pointerEnter(button)
    expect(tip()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(tip()?.textContent).toBe('Fast')
  })

  it('follows the trigger on scroll instead of hiding', () => {
    render(
      <Tooltip content="Scroll tip" delayMs={50}>
        <button type="button">Scroll</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Scroll' }))
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(tip()).not.toBeNull()

    fireEvent.scroll(window)
    expect(tip()).not.toBeNull()
  })

  it('clamps the open tip box inside the viewport when the trigger sits at the edge', () => {
    // jsdom viewport: 1024×768. Trigger at the right edge clamps its anchor
    // center to ~1016; the simulated wide tip (856..1176) overflows right.
    const wideTip = rect(856, 274, 320, 20)
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'tooltip') return wideTip
        if (this.textContent === 'Edge') return rect(1000, 300, 30, 30)
        return rect(0, 0, 0, 0)
      })

    render(
      <Tooltip content="Wide tip" delayMs={50}>
        <button type="button">Edge</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Edge' }))
    act(() => {
      vi.advanceTimersByTime(50)
    })

    // Anchor 1015 + shift -160 → tip box pulled back to 695..1015, fully visible
    expect(tip()?.style.left).toBe('855px')
    spy.mockRestore()
  })

  it('flips a tall tip to the bottom side when the top side cannot fit it', () => {
    // Trigger 50px from the top — above the 40px trigger flip threshold, but
    // the simulated 90px-tall tip cannot fit; the measured pass flips it.
    const tallTop = rect(155, -46, 320, 90)
    const tallBottom = rect(155, 86, 320, 90)
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'tooltip') {
          return this.classList.contains('-translate-y-full') ? tallTop : tallBottom
        }
        if (this.textContent === 'Top edge') return rect(500, 50, 30, 30)
        return rect(0, 0, 0, 0)
      })

    render(
      <Tooltip content="Tall tip" delayMs={50}>
        <button type="button">Top edge</button>
      </Tooltip>
    )

    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Top edge' }))
    act(() => {
      vi.advanceTimersByTime(50)
    })

    expect(tip()?.className).not.toContain('-translate-y-full')
    expect(tip()?.style.top).toBe('86px')
    spy.mockRestore()
  })
})

describe('IconButton tooltip', () => {
  it('shows label as tooltip text on hover', () => {
    render(<IconButton icon="gear" label="Settings" />)

    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button.getAttribute('title')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Settings')

    fireEvent.pointerEnter(button)
    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Settings')
  })

  it('shows why-disabled tip via wrapper when disabled', () => {
    render(
      <IconButton icon="plus" label="New chat" title="Open a workspace first" disabled />
    )

    const button = screen.getByRole('button', { name: 'New chat' })
    expect(button.hasAttribute('disabled')).toBe(true)

    const wrap = button.parentElement
    expect(wrap).toBeTruthy()
    fireEvent.pointerEnter(wrap!)
    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Open a workspace first')
  })
})

describe('Button disabled why-tip', () => {
  it('keeps a native title on enabled buttons', () => {
    render(<Button title="Native hint">Ok</Button>)

    expect(screen.getByRole('button', { name: 'Ok' }).getAttribute('title')).toBe(
      'Native hint'
    )
    expect(tip()).toBeNull()
  })

  it('wraps a disabled button so its title shows as a tooltip', () => {
    render(
      <Button disabled title="Add a workspace first">
        Add
      </Button>
    )

    const button = screen.getByRole('button', { name: 'Add' })
    expect(button.hasAttribute('disabled')).toBe(true)
    // Native title is stripped — it would never show on a disabled control
    expect(button.getAttribute('title')).toBeNull()

    const wrap = button.parentElement
    expect(wrap?.tagName).toBe('SPAN')
    fireEvent.pointerEnter(wrap!)
    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(tip()?.textContent).toBe('Add a workspace first')
  })
})
