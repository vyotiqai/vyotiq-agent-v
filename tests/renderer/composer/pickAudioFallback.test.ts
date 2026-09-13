import { describe, expect, it } from 'vitest'
import { pickAudioFallback } from '@renderer/features/chat/components/composer/composerModelUtils'
import type { ModelInfo } from '@shared/ipc'

const models: ModelInfo[] = [
  {
    id: 'text-only',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: false
  },
  {
    id: 'vision-only',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: true
  },
  {
    id: 'audio-model',
    inputModalities: ['text', 'audio'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: false
  }
]

describe('pickAudioFallback', () => {
  it('returns null when the current model already supports audio', () => {
    expect(
      pickAudioFallback(models, 'audio-model', { hasWorkspace: true, hasImages: false, hasAudio: true })
    ).toBeNull()
  })

  it('returns the first audio-capable model when current does not', () => {
    expect(
      pickAudioFallback(models, 'text-only', { hasWorkspace: true, hasImages: false, hasAudio: true })
    ).toBe('audio-model')
  })

  it('skips vision-only models that lack audio', () => {
    expect(
      pickAudioFallback(models, 'vision-only', { hasWorkspace: false, hasImages: false, hasAudio: true })
    ).toBe('audio-model')
  })
})
