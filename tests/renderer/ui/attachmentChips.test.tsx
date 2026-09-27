/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FileChip } from '@renderer/lib/ui/FileChip'
import { ImageChip } from '@renderer/lib/ui/ImageChip'
import { ImageLightbox } from '@renderer/lib/ui/ImageLightbox'

afterEach(() => {
  cleanup()
})

describe('FileChip', () => {
  it('is a chip, not a menu-radius pill, and rings its open button', () => {
    const onOpen = vi.fn()
    render(<FileChip name="notes.md" chars={1200} onOpen={onOpen} />)
    const open = screen.getByRole('button', { name: /notes\.md/ })
    const frame = open.parentElement!
    expect(frame.classList.contains('rounded-md')).toBe(true)
    expect(frame.classList.contains('rounded-xl')).toBe(false)
    expect(open.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('removes through the shared icon button, and locks it with the chip', () => {
    const onRemove = vi.fn()
    const { rerender } = render(<FileChip name="notes.md" onRemove={onRemove} />)
    const remove = screen.getByRole('button', { name: 'Remove notes.md' })
    expect(remove.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledTimes(1)

    rerender(<FileChip name="notes.md" onRemove={onRemove} disabled />)
    expect(screen.getByRole('button', { name: 'Remove notes.md' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('ImageChip', () => {
  it('opens from a real button that keeps its focus ring unclipped', () => {
    const onClick = vi.fn()
    render(<ImageChip url="data:image/png;base64,xx" label="Image 1" onClick={onClick} />)
    const open = screen.getByRole('button', { name: 'Image 1' })
    expect(open.tagName).toBe('BUTTON')
    expect(open.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
    expect(open.parentElement!.className).not.toMatch(/overflow-hidden|rounded-xl/)
    fireEvent.click(open)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('removes without opening', () => {
    const onClick = vi.fn()
    const onRemove = vi.fn()
    render(<ImageChip url="data:image/png;base64,xx" label="Image 1" onClick={onClick} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Image 1' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is a plain thumbnail when it cannot be opened', () => {
    render(<ImageChip url="data:image/png;base64,xx" label="Image 1" />)
    expect(screen.getByAltText('Image 1')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ImageLightbox', () => {
  it('draws one scrim and focuses a labelled close button', () => {
    const onClose = vi.fn()
    render(<ImageLightbox url="data:image/png;base64,xx" label="Image 1" onClose={onClose} />)
    const close = screen.getByRole('button', { name: 'Close image preview' })
    expect(document.activeElement).toBe(close)
    expect(document.body.querySelectorAll('.bg-overlay')).toHaveLength(1)
    expect(screen.getByAltText('Image 1').className).not.toMatch(/shadow-/)
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
