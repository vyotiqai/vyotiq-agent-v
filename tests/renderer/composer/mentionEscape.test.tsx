/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useComposerDraft } from '@renderer/features/chat/components/composer/useComposerDraft'

function EscapeHarness({
  onMentionBack,
  onMentionDismiss
}: {
  onMentionBack: () => boolean
  onMentionDismiss: () => void
}) {
  const { onKeyDown } = useComposerDraft({
    draft: '@x',
    onDraftChange: () => {},
    images: [],
    setImages: () => {},
    setImageError: () => {},
    files: [],
    setFiles: () => {},
    setFileError: () => {},
    onSend: async () => true,
    mentionMenuOpen: true,
    onMentionBack,
    onMentionDismiss
  })
  return <textarea aria-label="Message" onKeyDown={onKeyDown} />
}

describe('useComposerDraft mention Escape', () => {
  it('prefers subview back over dismiss', () => {
    const onMentionBack = vi.fn(() => true)
    const onMentionDismiss = vi.fn()
    const { getByLabelText } = render(
      <EscapeHarness onMentionBack={onMentionBack} onMentionDismiss={onMentionDismiss} />
    )
    fireEvent.keyDown(getByLabelText('Message'), { key: 'Escape' })
    expect(onMentionBack).toHaveBeenCalled()
    expect(onMentionDismiss).not.toHaveBeenCalled()
  })

  it('dismisses when back is unavailable', () => {
    const onMentionBack = vi.fn(() => false)
    const onMentionDismiss = vi.fn()
    const { getByLabelText } = render(
      <EscapeHarness onMentionBack={onMentionBack} onMentionDismiss={onMentionDismiss} />
    )
    fireEvent.keyDown(getByLabelText('Message'), { key: 'Escape' })
    expect(onMentionBack).toHaveBeenCalled()
    expect(onMentionDismiss).toHaveBeenCalled()
  })
})
