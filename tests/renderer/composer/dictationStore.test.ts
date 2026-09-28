import { describe, expect, it } from 'vitest'
import { DEFAULT_DICTATION_SETTINGS, type DictationLocalModelId, type DictationRuntimeStatus } from '@shared/ipc'
import { localLiveDrafts } from '@renderer/features/chat/components/composer/take/dictationStore'

function runtime(installed: DictationLocalModelId[]): DictationRuntimeStatus {
  return {
    phase: 'ready',
    progress: null,
    message: null,
    error: null,
    installed: installed.map((id) => ({ id, bytesOnDisk: 1, loaded: false })),
    recommendedModelId: 'whisper-small.en',
    engine: 'local',
    activeModelId: null,
    loadedModelId: null
  }
}

const local = (localModelId: DictationLocalModelId | '') => ({ ...DEFAULT_DICTATION_SETTINGS, engine: 'local' as const, localModelId })

describe('who drafts live words on this PC', () => {
  it('Whisper Tiny drafts for any chosen model, Moonshine included', () => {
    expect(localLiveDrafts(local('moonshine-base'), runtime(['moonshine-base', 'whisper-tiny.en']))).toBe(true)
    expect(localLiveDrafts(local('whisper-small.en'), runtime(['whisper-small.en', 'whisper-tiny.en']))).toBe(true)
  })

  it('a chosen Whisper model drafts for itself', () => {
    expect(localLiveDrafts(local('whisper-small.en'), runtime(['whisper-small.en']))).toBe(true)
  })

  it('Moonshine alone never drafts speech cut mid-word', () => {
    expect(localLiveDrafts(local('moonshine-base'), runtime(['moonshine-base']))).toBe(false)
    expect(localLiveDrafts(local('moonshine-base'), runtime(['moonshine-base', 'whisper-small.en']))).toBe(false)
    expect(localLiveDrafts(local(''), runtime(['moonshine-base']))).toBe(false)
  })
})
