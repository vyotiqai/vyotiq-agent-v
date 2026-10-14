/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useComposerAudio } from '@renderer/features/chat/components/composer/useComposerAudio'

/**
 * Audio attachments: every file that didn't go is said, even when one after
 * it did — a later success must not wipe the notice for an earlier skip.
 */
describe('useComposerAudio', () => {
  it('keeps the notice for a skipped file when a later one is added', async () => {
    const { result } = renderHook(() => useComposerAudio(null))
    const bad = new File(['x'], 'notes.txt', { type: 'text/plain' })
    const good = new File(['RIFF'], 'clip.wav', { type: 'audio/wav' })
    await act(async () => {
      await result.current.addAudio([bad, good])
    })
    expect(result.current.audio).toHaveLength(1)
    expect(result.current.audioError).toBe('Unsupported audio type: notes.txt')
  })

  it('says nothing when every file went', async () => {
    const { result } = renderHook(() => useComposerAudio(null))
    await act(async () => {
      await result.current.addAudio([new File(['RIFF'], 'a.wav', { type: 'audio/wav' })])
    })
    expect(result.current.audioError).toBeNull()
  })
})
