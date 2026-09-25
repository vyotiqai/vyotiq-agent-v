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

  /**
   * Between two flush panes the pane's border is the rule: a border stays one
   * device pixel at every display scale, where a drawn 1px line came out one or
   * two. The handle takes no room, draws nothing at rest and lights the rule up.
   */
  it('leaves the rule to the pane at rest and lights it up on a drag', () => {
    render(
      <PanelResizeHandle
        label="Resize navigator"
        value={264}
        min={200}
        max={420}
        edge="end"
        onChange={vi.fn()}
        hairline
      />
    )
    const handle = screen.getByRole('separator', { name: /Resize navigator/i })
    const line = handle.querySelector('[data-resize-line]')
    if (!line) throw new Error('resize handle rendered no line')

    expect(handle.classList.contains('w-0')).toBe(true)
    expect(handle.classList.contains('w-1.5')).toBe(false)
    expect(line.classList.contains('left-0')).toBe(true)
    expect(line.classList.contains('-translate-x-1/2')).toBe(false)
    expect(line.classList.contains('bg-border')).toBe(false)
    expect(line.classList.contains('group-hover:bg-border-strong')).toBe(true)

    fireEvent.mouseDown(handle, { clientX: 264, button: 0 })
    expect(line.classList.contains('bg-accent')).toBe(true)
    fireEvent.mouseUp(window)
    expect(line.classList.contains('bg-accent')).toBe(false)
    // Taking no room, it still has a hit area reaching into both panes.
    const spans = Array.from(handle.querySelectorAll('span'))
    expect(spans.some((span) => span.classList.contains('-inset-x-[3px]'))).toBe(true)
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
