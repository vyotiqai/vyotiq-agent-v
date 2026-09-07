/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ComposerPlusButton } from '@renderer/features/chat/components/composer/ComposerPlusButton'
import { DictationErrorBanner } from '@renderer/features/chat/components/composer/DictationSessionStrip'
import { chromeRow } from '@renderer/features/chat/components/composer/composerChrome'

afterEach(() => {
  cleanup()
})

describe('ComposerPlusButton capacity hint', () => {
  it('keeps the resting label when nothing is full', () => {
    render(<ComposerPlusButton onAttach={vi.fn()} />)
    const plus = screen.getByRole('button', { name: /^Attach files$/i })
    expect(plus.getAttribute('aria-label')).toBe('Attach files')
    expect(plus).toHaveProperty('disabled', false)
  })

  it('announces full buckets and remaining slots when partially constrained', () => {
    render(
      <ComposerPlusButton
        attachHint="Images full · 3 file slots left · 1 audio left"
        onAttach={vi.fn()}
      />
    )
    const plus = screen.getByRole('button', { name: /^Attach files/i })
    expect(plus.getAttribute('aria-label')).toBe(
      'Attach files — Images full · 3 file slots left · 1 audio left'
    )
    expect(plus).toHaveProperty('disabled', false)
  })

  it('disables only when every bucket is full', () => {
    render(
      <ComposerPlusButton
        attachFull
        attachHint="Images full · Files full · Audio full"
        onAttach={vi.fn()}
      />
    )
    const plus = screen.getByRole('button', { name: /Attachment limits reached/i })
    expect(plus).toHaveProperty('disabled', true)
  })
})

describe('chrome row banner', () => {
  it('reuses the shared 32px chrome row for the dictation error banner', () => {
    const { container } = render(
      <DictationErrorBanner message="boom" settingsSection={null} onDismiss={() => {}} />
    )
    expect(container.firstElementChild?.className).toBe(chromeRow)
  })
})
