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
    fireEvent.click(screen.getByRole('radio', { name: 'Patient' }))
    expect(runUpdate).toHaveBeenCalledWith({ voice: expect.objectContaining({ endOfTurnPatience: 'patient' }) })
  })

  it('says who answers out loud, and what happens without its key (D-44); talking over it is no longer a setting', () => {
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={{ ...emptySecretStatus(), openrouter: true }} />)
    const row = () => document.querySelector('[data-settings-field="voice-responder"]')!
    expect(row().textContent).toContain('Answers with')
    expect(row().textContent).toContain('hands work to the agent')
    expect(screen.getByRole('button', { name: 'Answers with: model' }).textContent).toContain('anthropic/claude-haiku-5.5')
    expect(document.querySelector('[data-settings-field="voice-interrupt"]')).toBeNull()
    cleanup()
    render(<VoiceModeSettings form={makeForm().form} secrets={emptySecretStatus()} />)
    expect(row().textContent).toContain('No OpenRouter key: what you say goes straight to the agent.')
  })

  it('lists the provider’s voices and previews the chosen one at the chosen speed', async () => {
    const { form } = makeForm({
      voice: { ...DEFAULT_SETTINGS.voice, speed: 1.15, tts: { openai: { voiceId: 'nova' } } }
    })
    render(<VoiceModeSettings form={form} secrets={{ ...emptySecretStatus(), openai: true }} />)
    await waitFor(() => expect(voiceListVoices).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o-mini-tts' }))
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

  it('an unset language says what the listener does with it (A-15)', () => {
    const { form } = makeForm({ voice: { ...DEFAULT_SETTINGS.voice, sttProvider: 'elevenlabs', language: '' } })
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    const row = () => document.querySelector('[data-settings-field="voice-language"]')!.textContent
    expect(row()).toContain('Detect automatically')
    cleanup()
    // Deepgram's blank is its English model, and an explicit English saved elsewhere reads the same.
    const deepgram = makeForm({ voice: { ...DEFAULT_SETTINGS.voice, sttProvider: 'deepgram', language: 'en' } })
    render(<VoiceModeSettings form={deepgram.form} secrets={emptySecretStatus()} />)
    expect(row()).toContain('English')
    expect(row()).not.toContain('Detect automatically')
  })
})

describe('Settings → Voice mode: OpenRouter credit (A-08)', () => {
  const openrouterListens = () =>
    makeForm({ voice: { ...DEFAULT_SETTINGS.voice, sttProvider: 'openrouter' } })
  const withCredit = (data: unknown) => {
    const voiceOpenRouterCredit = vi.fn(async () => ({ ok: true, data }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.voiceOpenRouterCredit = voiceOpenRouterCredit
    return voiceOpenRouterCredit
  }
  const note = () => document.querySelector('[data-settings-field="voice-stt"] [data-voice-credit]')

  it('states the $0.50 floor when OpenRouter listens', async () => {
    withCredit({ status: 'ok' })
    render(<VoiceModeSettings form={openrouterListens().form} secrets={{ ...emptySecretStatus(), openrouter: true }} />)
    await waitFor(() => expect(note()?.getAttribute('data-voice-credit')).toBe('ok'))
    expect(note()!.textContent).toContain('at least $0.50 of credit')
  })

  it('warns for an account that never paid, and for a nearly spent key limit', async () => {
    withCredit({ status: 'low', reason: 'never_paid' })
    render(<VoiceModeSettings form={openrouterListens().form} secrets={{ ...emptySecretStatus(), openrouter: true }} />)
    await waitFor(() => expect(note()?.getAttribute('data-voice-credit')).toBe('low'))
    expect(note()!.textContent).toContain('hasn’t bought credit yet')
    cleanup()
    withCredit({ status: 'low', reason: 'key_limit', keyRemaining: 0.12 })
    render(<VoiceModeSettings form={openrouterListens().form} secrets={{ ...emptySecretStatus(), openrouter: true }} />)
    await waitFor(() => expect(note()?.textContent).toContain('has $0.12 left'))
  })

  it('says nothing about credit for another listener, or without a key', () => {
    const ask = withCredit({ status: 'ok' })
    render(<VoiceModeSettings form={openrouterListens().form} secrets={emptySecretStatus()} />)
    expect(note()).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('Settings → Voice mode: models from the providers (D-36, D-37)', () => {
  const openrouterOnly = { ...emptySecretStatus(), openrouter: true }

  function withModels(impl: (req: { direction: string; provider: string }) => unknown) {
    const voiceModels = vi.fn(async (req: { direction: string; provider: string }) => ({ ok: true, data: impl(req) }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.voiceModels = voiceModels
    return voiceModels
  }

  it('shows both model rows for a provider with one curated model, fetched with prices', async () => {
    const voiceModels = withModels((req) => ({
      source: 'api',
      fetchedAt: Date.now(),
      models:
        req.direction === 'tts'
          ? [
              { id: 'elevenlabs/eleven-flash-v2.5', label: 'ElevenLabs: Eleven Flash v2.5', price: '$0.02 / 1k characters', recommended: true },
              { id: 'hexgrad/kokoro-82m', label: 'hexgrad: Kokoro 82M', price: '$0.00062 / 1k characters' }
            ]
          : [{ id: 'openai/gpt-transcribe', label: 'OpenAI: GPT Transcribe', price: '$0.0045 / min', recommended: true }]
    }))
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={openrouterOnly} />)
    await waitFor(() => expect(voiceModels).toHaveBeenCalledWith({ direction: 'tts', provider: 'openrouter', refresh: false }))
    expect(voiceModels).toHaveBeenCalledWith({ direction: 'stt', provider: 'openrouter', refresh: false })
    const speakModel = document.querySelector('[data-settings-field="voice-tts-model"]')!
    await waitFor(() => expect(speakModel.textContent).toContain('2 models from OpenRouter · updated just now'))
    expect(speakModel.textContent).toContain('ElevenLabs: Eleven Flash v2.5 · Recommended · $0.02 / 1k characters')
    const listenModel = document.querySelector('[data-settings-field="voice-stt-model"]')!
    await waitFor(() => expect(listenModel.textContent).toContain('OpenAI: GPT Transcribe · Recommended · $0.0045 / min'))
  })

  it('a curated provider says why it has no fetched list', async () => {
    withModels(() => ({ source: 'curated', models: [{ id: 'flux-general-en', label: 'Flux · English', recommended: true }] }))
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={emptySecretStatus()} />)
    const listenModel = document.querySelector('[data-settings-field="voice-stt-model"]')!
    await waitFor(() => expect(listenModel.textContent).toContain('no Flux models'))
    expect(listenModel.querySelector('button[aria-label^="Fetch"]')).toBeNull()
  })

  it('a failed fetch says so, with the reason, over the usual models', async () => {
    withModels(() => ({
      source: 'curated',
      models: [{ id: 'elevenlabs/eleven-flash-v2.5', label: 'ElevenLabs: Eleven Flash v2.5', recommended: true }],
      error: 'offline',
      detail: 'fetch failed'
    }))
    const { form } = makeForm()
    render(<VoiceModeSettings form={form} secrets={openrouterOnly} />)
    const speakModel = document.querySelector('[data-settings-field="voice-tts-model"]')!
    await waitFor(() => expect(speakModel.textContent).toContain('Couldn’t load OpenRouter’s models, so these are the usual ones.'))
    expect(speakModel.textContent).toContain('fetch failed')
  })

  it('a pick is saved per provider, and Refresh fetches again', async () => {
    const voiceModels = withModels(() => ({
      source: 'api',
      fetchedAt: Date.now(),
      models: [
        { id: 'elevenlabs/eleven-flash-v2.5', label: 'Eleven Flash', recommended: true },
        { id: 'hexgrad/kokoro-82m', label: 'Kokoro' }
      ]
    }))
    const { form, runUpdate } = makeForm()
    render(<VoiceModeSettings form={form} secrets={openrouterOnly} />)
    const speakModel = document.querySelector<HTMLElement>('[data-settings-field="voice-tts-model"]')!
    await waitFor(() => expect(speakModel.textContent).toContain('2 models'))
    fireEvent.click(speakModel.querySelector('button[aria-label="Voice model"]')!)
    fireEvent.click(await screen.findByRole('option', { name: /Kokoro/ }))
    expect(runUpdate).toHaveBeenCalledWith({
      voice: expect.objectContaining({ tts: expect.objectContaining({ openrouter: expect.objectContaining({ model: 'hexgrad/kokoro-82m' }) }) })
    })
    fireEvent.click(speakModel.querySelector('button[aria-label="Fetch OpenRouter’s models again"]')!)
    await waitFor(() => expect(voiceModels).toHaveBeenCalledWith({ direction: 'tts', provider: 'openrouter', refresh: true }))
  })

  it('shows the voice OpenRouter will really use, not a saved one the model refuses (A-06)', async () => {
    withModels(() => ({ source: 'api', fetchedAt: Date.now(), models: [{ id: 'elevenlabs/eleven-flash-v2.5', label: 'Eleven Flash', recommended: true }] }))
    voiceListVoices.mockImplementation(async () => ({
      ok: true,
      data: [
        { id: 'george', label: 'George' },
        { id: 'sarah', label: 'Sarah' }
      ]
    }))
    const { form } = makeForm({ voice: { ...DEFAULT_SETTINGS.voice, tts: { openrouter: { voiceId: 'alloy' } } } } as Partial<Settings>)
    render(<VoiceModeSettings form={form} secrets={openrouterOnly} />)
    await waitFor(() =>
      expect(voiceListVoices).toHaveBeenCalledWith({ provider: 'openrouter', model: 'elevenlabs/eleven-flash-v2.5' })
    )
    const voiceRow = document.querySelector('[data-settings-field="voice-voice"]')!
    await waitFor(() => expect(voiceRow.querySelector('button[aria-label="Voice"]')!.textContent).toContain('Sarah'))
  })
})
