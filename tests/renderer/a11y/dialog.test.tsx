/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Dialog } from '@renderer/lib/a11y/Dialog'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.open = false
  })
})

afterEach(() => {
  cleanup()
})

describe('Dialog', () => {
  it('exposes dialog semantics with labelled title', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Confirm action" useNativeDialog={false}>
        <button type="button">OK</button>
      </Dialog>
    )
    expect(screen.getByRole('dialog', { name: 'Confirm action' })).toBeTruthy()
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="Test dialog" useNativeDialog={false}>
        <button type="button">OK</button>
      </Dialog>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('frames the native dialog with the menu surface and titles it at heading size', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Native" useNativeDialog>
        <p>Body</p>
      </Dialog>
    )
    const dialog = document.querySelector('dialog')!
    expect(dialog.classList.contains('vy-menu')).toBe(true)
    expect(dialog.className).not.toMatch(/rounded-xl|bg-surface|shadow-menu|\bborder\b/)
    const title = screen.getByRole('heading', { name: 'Native' })
    expect(title.classList.contains('text-heading')).toBe(true)
    expect(title.classList.contains('font-semibold')).toBe(true)
    expect(title.className).not.toMatch(/text-md/)
  })

  it('ends in a footer row on the body inset, actions on the right edge', () => {
    render(
      <Dialog
        open
        onClose={vi.fn()}
        title="With footer"
        useNativeDialog={false}
        footer={<button type="button">Save</button>}
      >
        <p>Body</p>
      </Dialog>
    )
    const row = screen.getByRole('button', { name: 'Save' }).parentElement!
    expect(row.className).toMatch(/\bborder-t\b/)
    expect(row.classList.contains('justify-end')).toBe(true)
    expect(row.classList.contains('px-5')).toBe(true)
    // After the body, inside the dialog.
    const dialog = screen.getByRole('dialog', { name: 'With footer' })
    expect(dialog.lastElementChild).toBe(row)
  })

  it('insets the footer like the h-12 header family when the content draws its own', () => {
    render(
      <Dialog
        open
        onClose={vi.fn()}
        label="Own header"
        padded={false}
        useNativeDialog={false}
        footer={<button type="button">Done</button>}
      >
        <p>Body</p>
      </Dialog>
    )
    const row = screen.getByRole('button', { name: 'Done' }).parentElement!
    expect(row.classList.contains('px-4')).toBe(true)
    expect(row.classList.contains('px-5')).toBe(false)
  })
})
