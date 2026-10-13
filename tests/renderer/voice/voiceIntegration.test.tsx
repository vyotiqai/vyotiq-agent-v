/**
 * @vitest-environment jsdom
 *
 * Where voice mode meets the rest of the app: the spoken summary never leaks
 * into written output, and voice mode doesn't talk over itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { latestResultText } from '@renderer/features/chat/components/prDraft'
import { ReadAloudButton } from '@renderer/features/voice/ReadAloudButton'
import { resetVoiceModeForTests, startVoiceMode } from '@renderer/features/voice/voiceMode'
import { resetSpeechForTests } from '@renderer/features/voice/speechPlayback'
import { speakingProblem, voiceProblem } from '@renderer/features/voice/voiceCopy'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'

class FakeController extends VoiceSessionController {
  fakeSnap: VoiceSnapshot = { ...IDLE_VOICE }
  subs = new Set<() => void>()
  constructor() {
    super({ onTurn: () => null })
  }
  override get snapshot(): VoiceSnapshot {
    return this.fakeSnap
  }
  override subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
  override async start(): Promise<void> {
    this.fakeSnap = { ...this.fakeSnap, state: 'listening' }
    for (const s of this.subs) s()
  }
  override async stop(): Promise<void> {
    this.fakeSnap = { ...IDLE_VOICE }
    for (const s of this.subs) s()
  }
}

const at = (s: number): string => new Date(Date.UTC(2026, 9, 11, 10, 0, s)).toISOString()

beforeEach(async () => {
  await resetVoiceModeForTests(new FakeController())
  window.vyotiq = {
    platform: 'win32',
    voiceStopSpeaking: vi.fn(async () => ({ ok: true, data: true }))
  } as never
})

afterEach(async () => {
  cleanup()
  resetSpeechForTests()
  await resetVoiceModeForTests()
})

describe('the spoken summary stays out of written output', () => {
  it('a PR drafted from a voice answer gets the written answer only', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'fix the retry', at: at(0) },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '<spoken>Fixed it. Details on screen.</spoken>\nRetries now back off exponentially.',
        at: at(5)
      }
    ] as UiItem[]
    expect(latestResultText(items)).toBe('Retries now back off exponentially.')
  })
})

describe('one voice at a time', () => {
  it('read aloud is off during a conversation', async () => {
    render(<ReadAloudButton text="Done." owner="r1" />)
    expect(screen.getByRole('button', { name: 'Read aloud' }).hasAttribute('disabled')).toBe(false)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    expect(screen.getByRole('button', { name: 'Read aloud' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('speaking problems are worded for the voice', () => {
  it('a missing speaking key is not called a listening key', () => {
    expect(speakingProblem('no_key')).toEqual({ message: 'No speaking voice has a key.', fix: 'settings' })
    expect(voiceProblem('no_key').message).toContain('listening')
  })
})
