/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PanelResizeHandle } from '@renderer/lib/ui/PanelResizeHandle'

afterEach(() => {
  cleanup()
})

describe('PanelResizeHandle', () => {
  it('grows an end-edge panel when dragging right', () => {
    const onChange = vi.fn()
    render(
      <PanelResizeHandle
        label="Resize sidebar"
        value={220}
        min={180}
        max={420}
        edge="end"
        onChange={onChange}
      />
    )
    const handle = screen.getByRole('separator', { name: /Resize sidebar/i })
    fireEvent.mouseDown(handle, { clientX: 100, button: 0 })
    fireEvent.mouseMove(window, { clientX: 140 })
    expect(onChange).toHaveBeenCalledWith(260)
    fireEvent.mouseUp(window)
  })

  it('grows a start-edge panel when dragging left', () => {
    const onChange = vi.fn()
    render(
      <PanelResizeHandle
        label="Resize panel"
        value={480}
        min={280}
        max={960}
        edge="start"
        onChange={onChange}
      />
    )
    const handle = screen.getByRole('separator', { name: /Resize panel/i })
    fireEvent.mouseDown(handle, { clientX: 500, button: 0 })
    fireEvent.mouseMove(window, { clientX: 420 })
    expect(onChange).toHaveBeenCalledWith(560)
    fireEvent.mouseUp(window)
  })

  it('nudges width with arrow keys', () => {
    const onChange = vi.fn()
    render(
      <PanelResizeHandle
        label="Resize sidebar"
        value={220}
        min={180}
        max={420}
        edge="end"
        onChange={onChange}
      />
    )
    const handle = screen.getByRole('separator', { name: /Resize sidebar/i })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith(228)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(onChange).toHaveBeenCalledWith(180)
  })

  /**
   * The drag colour has to REPLACE the hover colour, not sit beside it. As an
   * appended class it lost on specificity — Tailwind emits group-hover as
   * `:is(:where(.group):hover *)`, which outranks a bare `.bg-accent` — and
   * pointer capture keeps `:hover` on the handle for the whole gesture, so the
   * gutter stayed `border-strong` from mousedown to mouseup.
   */
  it('swaps the hover colour out for the drag colour, rather than adding to it', () => {
    render(
      <PanelResizeHandle
        label="Resize sidebar"
        value={220}
        min={180}
        max={420}
        edge="end"
        onChange={vi.fn()}
      />
    )
    const handle = screen.getByRole('separator', { name: /Resize sidebar/i })
    const indicator = handle.querySelector('span')
    if (!indicator) throw new Error('resize handle rendered no indicator')

    // classList, not the className string: `bg-accent` is a substring of the
    // resting `group-focus-visible:bg-accent`, so only whole-token matching
    // can tell the two states apart.
    expect(indicator.classList.contains('group-hover:bg-border-strong')).toBe(true)
    expect(indicator.classList.contains('bg-accent')).toBe(false)

    fireEvent.mouseDown(handle, { clientX: 100, button: 0 })
    expect(indicator.classList.contains('bg-accent')).toBe(true)
    expect(indicator.classList.contains('group-hover:bg-border-strong')).toBe(false)

    fireEvent.mouseUp(window)
    expect(indicator.classList.contains('group-hover:bg-border-strong')).toBe(true)
  })

  it('locks body selection and cursor while dragging', () => {
    const onChange = vi.fn()
    render(
      <PanelResizeHandle
        label="Resize sidebar"
        value={220}
        min={180}
        max={420}
        edge="end"
        onChange={onChange}
      />
    )
    const handle = screen.getByRole('separator', { name: /Resize sidebar/i })
    fireEvent.mouseDown(handle, { clientX: 100, button: 0 })
    expect(document.body.style.userSelect).toBe('none')
    expect(document.body.style.cursor).toBe('col-resize')
    fireEvent.mouseUp(window)
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
  })
})
