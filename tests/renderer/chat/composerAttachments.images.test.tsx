/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerAttachments } from '@renderer/features/chat/components/composer/ComposerAttachments'

afterEach(() => {
  cleanup()
})

describe('ComposerAttachments image chips', () => {
  it('shows a thumbnail and opens a lightbox', () => {
    render(
      <ComposerAttachments
        images={['data:image/png;base64,xx']}
        imageError={null}
        attachLocked={false}
        onRemove={() => undefined}
      />
    )
    const thumb = screen.getByAltText('Image 1')
    expect(thumb.getAttribute('src')).toBe('data:image/png;base64,xx')
    fireEvent.click(thumb.closest('[role="button"]')!)
    expect(screen.getByLabelText('Close image preview')).toBeTruthy()
  })
})
