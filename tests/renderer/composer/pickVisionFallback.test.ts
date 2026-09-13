import { describe, expect, it } from 'vitest'
import { pickVisionFallback } from '@renderer/features/chat/components/composer/composerModelUtils'
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
    id: 'vision-model',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: true
  }
]

describe('pickVisionFallback', () => {
  it('returns null when the current model already supports vision', () => {
    expect(
      pickVisionFallback(models, 'vision-model', { hasWorkspace: true, hasImages: true })
    ).toBeNull()
  })

  it('returns the first vision-capable model when current does not', () => {
    expect(
      pickVisionFallback(models, 'text-only', { hasWorkspace: true, hasImages: true })
    ).toBe('vision-model')
  })
})
