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
})
