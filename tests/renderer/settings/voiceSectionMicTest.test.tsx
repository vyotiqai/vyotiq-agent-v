/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { SettingsFormState } from '@renderer/features/settings/hooks/useSettingsForm'
import { VoiceSection } from '@renderer/features/settings/sections/VoiceSection'
import { resetVoiceModeForTests, startVoiceMode } from '@renderer/features/voice/voiceMode'
import { VoiceSessionController } from '@renderer/features/voice/voiceSessionController'

const capture = vi.hoisted(() => ({ stop: vi.fn() }))
vi.mock('@renderer/lib/audio/micCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/audio/micCapture')>()
  return {
    ...actual,
    openMicCapture: vi.fn(async () => capture),
    listMicDevices: vi.fn(async () => []),
    listSpeakerDevices: vi.fn(async () => [])
  }
})

/** A live session that only records what is asked of its mic. */
class MicSpy extends VoiceSessionController {
  held: boolean[] = []
  constructor() {
    super({ onTurn: () => null })
  }
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override setOutput(): void {}
  override holdMic(held: boolean): void {
    this.held.push(held)
  }
}

beforeEach(() => {
  capture.stop.mockReset()
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    platform: 'win32',
    dictationStatus: vi.fn(async () => ({ ok: false, error: 'not in this test' })),
    onDictationStatus: () => () => {}
  }
})

afterEach(async () => {
  cleanup()
  await resetVoiceModeForTests()
})

describe('Settings › Voice: the mic test during voice mode (2026-10-16 audit 3, A9)', () => {
  it('holds the live session’s mic while it measures, and gives it back when it stops', async () => {
    const spy = new MicSpy()
    await resetVoiceModeForTests(spy)
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    const form = {
      settings: DEFAULT_SETTINGS,
      formLocked: false,
      runUpdate: vi.fn(async () => ({ ok: true as const })),
      navigateSection: vi.fn(),
      nestedDefaultMark: () => ({ changed: false })
    } as unknown as SettingsFormState
    render(<VoiceSection form={form} secrets={emptySecretStatus()} />)
    const row = document.querySelector('[data-settings-field="dictation-input"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Stop' })).toBeTruthy())
    expect(spy.held).toEqual([true])
    fireEvent.click(within(row).getByRole('button', { name: 'Stop' }))
    expect(capture.stop).toHaveBeenCalled()
    expect(spy.held).toEqual([true, false])
  })
})
