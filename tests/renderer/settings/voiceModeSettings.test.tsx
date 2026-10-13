/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoiceModeSettings, voiceKeyProblem } from '@renderer/features/settings/sections/VoiceModeSettings'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings } from '@shared/ipc'
import type { SettingsFormState } from '@renderer/features/settings/hooks/useSettingsForm'
import type { VoiceKeyStatus } from '@shared/ipc/schemas/voice'
import { resetSpeechForTests } from '@renderer/features/voice/speechPlayback'

const noKeys: VoiceKeyStatus = {
  voice: { deepgram: { set: false }, assemblyai: { set: false }, elevenlabs: { set: false }, cartesia: { set: false } },
  chat: { openai: false, openrouter: false }
}

function makeForm(settings: Partial<Settings> = {}) {
  const runUpdate = vi.fn(async () => ({ ok: true as const }))
  const navigateSection = vi.fn()
  const form = {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    formLocked: false,
    runUpdate,
    navigateSection,
    nestedDefaultMark: () => ({ changed: false })
  } as unknown as SettingsFormState
  return { form, runUpdate, navigateSection }
}

let voiceKeyStatus: ReturnType<typeof vi.fn>
let voiceSetKey: ReturnType<typeof vi.fn>
let voiceClearKey: ReturnType<typeof vi.fn>
let voiceListVoices: ReturnType<typeof vi.fn>
let voiceSpeak: ReturnType<typeof vi.fn>

beforeEach(() => {
  voiceKeyStatus = vi.fn(async () => ({ ok: true, data: noKeys }))
  voiceSetKey = vi.fn()
  voiceClearKey = vi.fn()
  voiceListVoices = vi.fn(async () => ({
    ok: true,
    data: [
      { id: 'alloy', label: 'Alloy', description: 'Neutral' },
      { id: 'nova', label: 'Nova' }
    ]
  }))
  voiceSpeak = vi.fn(async () => ({ ok: true, data: { utteranceId: 'p1', provider: 'openai', voiceId: 'nova' } }))
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    voiceKeyStatus,
    voiceSetKey,
    voiceClearKey,
    voiceListVoices,
    voiceSpeak,
    voiceStopSpeaking: vi.fn(async () => ({ ok: true, data: true })),
    onVoiceAudioOut: () => () => {},
    onVoiceSpeakEnd: () => () => {},
    platform: 'win32'
  }
})

afterEach(() => {
  cleanup()
  resetSpeechForTests()
  vi.restoreAllMocks()
})

describe('Settings → Voice mode', () => {
  it('shows what Automatic resolves to when only an OpenAI key exists', async () => {
    const { form } = makeForm()
    const secrets = { ...emptySecretStatus(), openai: true }
    render(<VoiceModeSettings form={form} secrets={secrets} />)
    await waitFor(() => expect(voiceKeyStatus).toHaveBeenCalled())
    const listens = document.querySelector('[data-settings-field="voice-stt"]')!
    const speaks = document.querySelector('[data-settings-field="voice-tts"]')!
    expect(listens.textContent).toContain('Automatic · OpenAI')
    expect(listens.textContent).toContain('Audio goes to OpenAI')
    expect(speaks.textContent).toContain('Reply text goes to OpenAI')
  })

  it('lists a key row for every voice vendor and links chat keys to Providers', async () => {
    const { form, navigateSection } = makeForm()
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    for (const v of ['deepgram', 'assemblyai', 'elevenlabs', 'cartesia', 'openai', 'openrouter']) {
      expect(document.querySelector(`[data-voice-key="${v}"]`)).toBeTruthy()
    }
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage in Providers' })[0]!)
    expect(navigateSection).toHaveBeenCalledWith('providers')
  })

  it('saves a key through the check and shows it masked', async () => {
    voiceSetKey.mockResolvedValue({
      ok: true,
      data: { check: 'verified', status: { ...noKeys, voice: { ...noKeys.voice, deepgram: { set: true, last4: '3f9a' } } } }
    })
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    const row = (): Element => document.querySelector('[data-voice-key="deepgram"]')!
    fireEvent.click(row().querySelector('button')!)
    fireEvent.change(screen.getByLabelText('Deepgram API key'), { target: { value: ' dg-key ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(voiceSetKey).toHaveBeenCalledWith({ vendor: 'deepgram', key: ' dg-key ' }))
    await waitFor(() => expect(row().textContent).toContain('••••3f9a'))
    expect(row().textContent).toContain('Verified')
  })

  it('words a rejected key without showing provider text', async () => {
    voiceSetKey.mockResolvedValue({ ok: false, error: '{"detail":"invalid_api_key"}', code: 'voice:rejected_key' })
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    const row = document.querySelector('[data-voice-key="elevenlabs"]')!
    fireEvent.click(row.querySelector('button')!)
    fireEvent.change(screen.getByLabelText('ElevenLabs API key'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(voiceKeyProblem('rejected_key', 'ElevenLabs'))
    expect(alert.textContent).not.toContain('invalid_api_key')
  })

  it('writes behaviour changes into settings.voice', async () => {
    const { form, runUpdate } = makeForm()
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Stop the agent' }))
    expect(runUpdate).toHaveBeenCalledWith({ voice: expect.objectContaining({ interruptMode: 'cancel' }) })
  })

  it('lists the provider’s voices and previews the chosen one at the chosen speed', async () => {
    const { form } = makeForm({
      voice: { ...DEFAULT_SETTINGS.voice, speed: 1.15, tts: { openai: { voiceId: 'nova' } } }
    })
    render(<VoiceModeSettings form={form} secrets={{ ...emptySecretStatus(), openai: true }} />)
    await waitFor(() => expect(voiceListVoices).toHaveBeenCalledWith({ provider: 'openai' }))
    const row = document.querySelector('[data-settings-field="voice-voice"]')!
    await waitFor(() => expect(row.textContent).toContain('2 voices'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() =>
      expect(voiceSpeak).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'plain', provider: 'openai', voiceId: 'nova', speed: 1.15 })
      )
    )
  })

  it('without a key, the preview is off and says why', async () => {
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    const row = document.querySelector('[data-settings-field="voice-voice"]')!
    expect(row.textContent).toContain('Add your ElevenLabs key')
    expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('locks the language for an English-only listener', () => {
    const { form } = makeForm({ voice: { ...DEFAULT_SETTINGS.voice, sttProvider: 'local' } })
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    expect(document.querySelector('[data-settings-field="voice-language"]')!.textContent).toContain(
      'understands English only'
    )
  })
})
