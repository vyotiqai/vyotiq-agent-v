/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, dictationIpcCode, emptySecretStatus } from '@shared/ipc'
import type { DictationTranscribeRequest } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import type { SlashClientHandlers } from '@renderer/features/chat/components/composer/slashCommandExecute'
import { resetDictationStoreForTests } from '@renderer/features/chat/components/composer/take/dictationStore'

/*
  The take, driven through the real Composer: the mic, the strip, the keys,
  and what lands in the draft. The microphone is the one fake — samples are
  pushed in as the ScriptProcessor tap would deliver them.
*/

const mic = vi.hoisted(() => {
  const state: {
    onSamples: ((pcm: Int16Array) => void) | null
    refuse: Error | null
    opened: number
    stopped: number
  } = { onSamples: null, refuse: null, opened: 0, stopped: 0 }
  return state
})

vi.mock('@renderer/lib/audio/micCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/audio/micCapture')>()
  return {
    ...actual,
    openMicCapture: vi.fn(async (o: { onSamples: (pcm: Int16Array) => void }) => {
      if (mic.refuse) throw mic.refuse
      mic.opened += 1
      mic.onSamples = o.onSamples
      return {
        deviceLabel: 'Test Mic',
        deviceId: 'mic-1',
        stop: () => {
          mic.stopped += 1
          mic.onSamples = null
        }
      }
    }),
    listMicDevices: vi.fn(async () => [
      { deviceId: '', label: 'System default' },
      { deviceId: 'mic-1', label: 'Test Mic' }
    ])
  }
})

const RATE = 16000
function tone(ms: number): Int16Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.3 * 32767)
  return out
}
const silence = (ms: number): Int16Array => new Int16Array(Math.round((RATE * ms) / 1000))

function speak(pcm: Int16Array): void {
  act(() => {
    for (let i = 0; i < pcm.length; i += 2048) mic.onSamples?.(pcm.subarray(i, i + 2048))
  })
}

// Only the fields the composer reads; the rest do not matter to a take.
const chatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
} as EffectiveChatSettings

const keyed = { ...emptySecretStatus(), openai: true }

type Reply = { ok: true; data: { text: string } } | { ok: false; error: string; code?: string }
let replies: Reply[] = []
let requests: DictationTranscribeRequest[] = []

function renderComposer(
  overrides?: Partial<{ secrets: ReturnType<typeof emptySecretStatus>; slashHandlers: SlashClientHandlers; onSend: () => void }>
) {
  return render(
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={false}
      hasWorkspace
      secrets={overrides?.secrets ?? keyed}
      chatSettings={chatSettings}
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={overrides?.onSend ?? vi.fn()}
      slashHandlers={overrides?.slashHandlers}
    />
  )
}

function field(): HTMLElement {
  return screen.getByLabelText('Instruction')
}

function strip(): HTMLElement | null {
  return document.querySelector('[data-take]')
}

async function startTake(): Promise<void> {
  await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Dictate$/ }))
  })
  await waitFor(() => expect(strip()?.dataset.take).toBe('listening'))
}

describe('Composer dictation (take)', () => {
  beforeEach(() => {
    resetDictationStoreForTests()
    mic.onSamples = null
    mic.refuse = null
    mic.opened = 0
    mic.stopped = 0
    replies = []
    requests = []
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    })
    window.vyotiq = {
      platform: 'win32',
      listModels: vi.fn(async () => ({ ok: true as const, data: { models: [], warning: null } })),
      getSettings: vi.fn(async () => ({ ok: true as const, data: DEFAULT_SETTINGS })),
      setSettings: vi.fn(async (patch: Partial<typeof DEFAULT_SETTINGS>) => ({
        ok: true as const,
        data: { ...DEFAULT_SETTINGS, ...patch }
      })),
      transcribeDictation: vi.fn(async (req: DictationTranscribeRequest) => {
        requests.push(req)
        return replies.shift() ?? { ok: true as const, data: { text: '' } }
      }),
      cancelDictation: vi.fn(async () => ({ ok: true as const, data: true })),
      dictationOpenMicSettings: vi.fn(async () => ({ ok: true as const, data: true })),
      dictationStatus: vi.fn(async () => ({
        ok: true as const,
        data: {
          phase: 'idle' as const,
          progress: null,
          message: null,
          error: null,
          installed: [],
          recommendedModelId: 'whisper-small.en' as const,
          engine: 'openai' as const,
          activeModelId: null,
          loadedModelId: null
        }
      }))
    } as unknown as typeof window.vyotiq
  })

  afterEach(() => {
    cleanup()
    resetDictationStoreForTests()
  })

  it('opens a take under the field; the paperclip steps aside and the mic reads Insert', async () => {
    renderComposer()
    await startTake()
    const s = strip()!
    expect(s.hasAttribute('data-take-open')).toBe(true)
    expect(within(s).getByText('0:00')).toBeTruthy()
    expect(within(s).getByTitle('Audio is sent to OpenAI with your key')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Attach files/ })).toBeNull()
    // An open take stands in for the whole control row: no mode, model or Send under it.
    expect(screen.queryByRole('radiogroup', { name: 'Mode' })).toBeNull()
    expect(document.querySelector('[data-model-picker]')).toBeNull()
    expect(screen.getByRole('button', { name: /^Insert \(Ctrl\+M\)$/ })).toBeTruthy()
    // The field is still there and says so; it is read-only for the take.
    expect(field().getAttribute('aria-readonly')).toBe('true')
    expect(field().getAttribute('contenteditable')).toBe('false')
  })

  it('shows settled words in the field while listening, then Enter inserts the take', async () => {
    renderComposer()
    await startTake()
    replies.push({ ok: true, data: { text: 'first phrase' } })
    speak(tone(1500))
    speak(silence(800))
    await waitFor(() => expect(field().textContent).toContain('first phrase'))
    expect(requests[0]).toMatchObject({ engine: 'openai', allowEmpty: true })

    replies.push({ ok: true, data: { text: 'second phrase' } })
    speak(tone(900))
    // Speech with no words yet holds its place with a marker.
    expect(field().textContent).toContain('…')
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(strip()?.dataset.take).toBe('inserted'))
    expect(field().textContent).toBe('first phrase second phrase')
    expect(within(strip()!).getByText('4')).toBeTruthy()
    expect(field().getAttribute('contenteditable')).toBe('true')
    // Closed: the note stays for Undo, but the controls are back under it — Send is the next thing.
    const row = document.querySelector<HTMLElement>('[data-composer-controls]')!
    expect(row.contains(strip())).toBe(false)
    expect(within(row).getByRole('radiogroup', { name: 'Mode' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Attach files/ })).toBeTruthy()
    expect(mic.stopped).toBe(1)
  })

  it('Undo puts the draft back as it was before the take', async () => {
    renderComposer()
    await startTake()
    replies.push({ ok: true, data: { text: 'undo me' } })
    speak(tone(900))
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(field().textContent).toBe('undo me'))
    fireEvent.click(within(strip()!).getByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(field().textContent).toBe(''))
    expect(strip()).toBeNull()
  })

  it('Esc discards the take, and Restore brings it back listening', async () => {
    renderComposer()
    await startTake()
    speak(tone(600))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(strip()?.dataset.take).toBe('discarded'))
    expect(within(strip()!).getByText(/Discarded a/)).toBeTruthy()
    // Restore sits above the controls; it does not hide them for its eight seconds.
    expect(document.querySelector('[data-model-picker]')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(strip()!).getByRole('button', { name: 'Restore' }))
    })
    await waitFor(() => expect(strip()?.dataset.take).toBe('listening'))
    expect(mic.opened).toBe(2)
  })

  it('Ctrl+Enter inserts and sends', async () => {
    const onSend = vi.fn()
    renderComposer({ onSend })
    await startTake()
    replies.push({ ok: true, data: { text: 'ship it' } })
    speak(tone(900))
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(String(onSend.mock.calls[0]![0])).toContain('ship it')
  })

  it('a failed take keeps its audio and says why; Retry sends it again', async () => {
    const onOpenSettings = vi.fn()
    renderComposer({ slashHandlers: { onOpenSettings } as SlashClientHandlers })
    await startTake()
    replies.push({ ok: false, error: 'OpenAI turned the key down (401)', code: dictationIpcCode('rejected_key') })
    speak(tone(900))
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(strip()?.dataset.take).toBe('failed'))
    const s = strip()!
    expect(within(s).getByRole('alert').textContent).toBe('OpenAI turned the key down (401)')
    expect(within(s).getByText(/kept/)).toBeTruthy()
    fireEvent.click(within(s).getByRole('button', { name: /Providers/ }))
    expect(onOpenSettings).toHaveBeenCalledWith('providers')

    replies.push({ ok: true, data: { text: 'second try' } })
    await act(async () => {
      fireEvent.click(within(strip()!).getByRole('button', { name: /Retry/ }))
    })
    await waitFor(() => expect(field().textContent).toBe('second try'))
    expect(requests).toHaveLength(2)
    expect(requests[1]!.pcm16k).toBe(requests[0]!.pcm16k)
  })

  it('with no way to transcribe, the mic opens Dictate with', async () => {
    const onOpenSettings = vi.fn()
    renderComposer({ secrets: emptySecretStatus(), slashHandlers: { onOpenSettings } as SlashClientHandlers })
    const setup = await screen.findByRole('button', { name: 'Set up dictation' })
    await act(async () => {
      fireEvent.click(setup)
    })
    const dialog = await screen.findByRole('dialog', { name: 'Dictate with' })
    expect(within(dialog).getByText('This PC')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /Install/ })).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Add key/ })[0]!)
    expect(onOpenSettings).toHaveBeenCalledWith('providers')
    expect(mic.opened).toBe(0)
  })

  it('a refused microphone turns the mic into the way to allow it', async () => {
    const { MicCaptureError } = await import('@renderer/lib/audio/micCapture')
    mic.refuse = new MicCaptureError('blocked', 'The microphone is blocked')
    renderComposer()
    await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/ }))
    })
    const dialog = await screen.findByRole('dialog', { name: 'Microphone blocked' })
    expect(within(dialog).getByText('Windows is blocking the microphone')).toBeTruthy()
    expect(within(dialog).getByText('Let desktop apps access your microphone')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /Open settings/ }))
    expect(window.vyotiq.dictationOpenMicSettings).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Microphone blocked/ })).toBeTruthy()
  })

  it('holding Ctrl+M talks until it is let go', async () => {
    renderComposer()
    await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
    field().focus()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true })
    })
    await waitFor(() => expect(strip()?.dataset.take).toBe('listening'))
    await waitFor(() => expect(within(strip()!).getByText(/Release/)).toBeTruthy(), { timeout: 1500 })
    replies.push({ ok: true, data: { text: 'held words' } })
    speak(tone(900))
    await act(async () => {
      fireEvent.keyUp(window, { key: 'm', ctrlKey: true })
    })
    await waitFor(() => expect(field().textContent).toBe('held words'))
  })

  it('a quick tap of Ctrl+M starts a take that a second tap inserts', async () => {
    renderComposer()
    await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
    field().focus()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true })
      fireEvent.keyUp(window, { key: 'm', ctrlKey: true })
    })
    await waitFor(() => expect(strip()?.dataset.take).toBe('listening'))
    replies.push({ ok: true, data: { text: 'tapped' } })
    speak(tone(900))
    await act(async () => {
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true })
    })
    await waitFor(() => expect(field().textContent).toBe('tapped'))
  })
})
