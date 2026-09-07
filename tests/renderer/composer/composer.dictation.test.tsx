/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState } from 'react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus, MAX_DICTATION_BYTES } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import type { SlashClientHandlers } from '@renderer/features/chat/components/composer/slashCommandExecute'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const chatSettings: EffectiveChatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
}

const keyedSecrets = { ...emptySecretStatus(), openai: true }

function installMediaMocks(opts?: { largeChunkBytes?: number }): {
  getUserMedia: ReturnType<typeof vi.fn>
} {
  class FakeMediaRecorder {
    static isTypeSupported(type: string): boolean {
      return type.startsWith('audio/webm')
    }
    state: 'inactive' | 'recording' = 'inactive'
    ondataavailable: ((ev: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    start(): void {
      this.state = 'recording'
      if (opts?.largeChunkBytes != null) {
        const size = opts.largeChunkBytes
        queueMicrotask(() => {
          if (this.state !== 'recording') return
          const data = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' })
          Object.defineProperty(data, 'size', { value: size })
          this.ondataavailable?.({ data })
        })
      }
    }
    stop(): void {
      this.state = 'inactive'
      this.ondataavailable?.({
        data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })
      })
      this.onstop?.()
    }
  }

  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: vi.fn() }]
  }))

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia }
  })
  return { getUserMedia }
}

function renderComposer(
  overrides?: Partial<{
    secrets: ReturnType<typeof emptySecretStatus>
    slashHandlers: SlashClientHandlers
    draft: string
    running: boolean
    onDraftChange: (draft: string) => void
  }>
) {
  return render(
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={overrides?.running ?? false}
      hasWorkspace
      secrets={overrides?.secrets ?? keyedSecrets}
      draft={overrides?.draft}
      onDraftChange={overrides?.onDraftChange}
      chatSettings={chatSettings}
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      slashHandlers={overrides?.slashHandlers}
    />
  )
}

describe('Composer dictation', () => {
  beforeEach(() => {
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
    installMediaMocks()
    // @ts-expect-error test bridge
    window.vyotiq = {
      platform: 'win32',
      listModels: vi.fn(async () => ({
        ok: true as const,
        data: { models: [], warning: null }
      })),
      getSettings: vi.fn(async () => ({
        ok: true as const,
        data: DEFAULT_SETTINGS
      })),
      transcribeDictation: vi.fn(async () => ({
        ok: true as const,
        data: { text: 'hello from mic' }
      })),
      cancelDictation: vi.fn(async () => ({ ok: true as const, data: true })),
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
    }
  })

  it('idle mic tooltip includes the dictation engine', async () => {
    renderComposer()
    await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
    // Focus-opened tooltips require a recent keydown (keyboard navigation);
    // clicks and programmatic focus deliberately do not open them.
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.focus(screen.getByRole('button', { name: /^Dictate$/i }))
    await waitFor(
      () => {
        expect(document.body.querySelector('[role="tooltip"]')?.textContent).toMatch(
          /Dictate \(Ctrl\+M\) · OpenAI/
        )
      },
      { timeout: 1500 }
    )
  })

  it('announces preflight as starting instead of listening', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.getSettings = vi.fn(() => new Promise(() => undefined))
    renderComposer()

    fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))

    expect(await screen.findByRole('status', { name: /Starting dictation/i })).toBeTruthy()
    expect(screen.queryByRole('status', { name: /^Listening/i })).toBeNull()
  })

  it('shows Dictate when empty, the strip while listening, and Send after transcript', async () => {
    renderComposer()

    const mic = screen.getByRole('button', { name: /^Dictate$/i })
    expect(mic).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull()

    await act(async () => {
      fireEvent.click(mic)
    })
    expect(screen.getByRole('button', { name: /^Stop dictation$/i })).toBeTruthy()
    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Cancel dictation$/i })).toBeTruthy()
    const strip = screen.getByRole('status', { name: /Listening/i })
    expect(strip.className).toMatch(/\bh-8\b/)
    expect(strip.className).toMatch(/(?:^|\s)gap-1\.5(?:\s|$)/)
    expect(strip.className).not.toMatch(/\bh-9\b/)
    const cancel = screen.getByRole('button', { name: /^Cancel dictation$/i })
    const confirm = screen.getByRole('button', { name: /^Stop dictation$/i })
    // Cancel keeps the neutral chrome button; the primary Stop button is accented.
    expect(cancel.className).not.toMatch(/\bbg-accent\b/)
    expect(confirm.className).toMatch(/\bbg-accent\b/)
    expect(cancel.className).toMatch(/\brounded-md\b/)
    expect(cancel.className).not.toMatch(/\brounded-full\b/)
    const shell = document.querySelector('[data-composer-shell]')
    expect(shell?.className).toMatch(/\bvy-chrome\b/)
    expect(shell?.className).not.toMatch(/\brounded-full\b/)
    expect(screen.queryByRole('button', { name: /^Dictate$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull()
    expect(screen.queryByRole('combobox', { name: /^Message$/i })).toBeNull()
    expect(screen.queryByText('Listening…')).toBeNull()
    expect(screen.queryByText(/^Listening$/)).toBeNull()
    const form = document.querySelector('[data-composer-shell] form')
    expect(form?.className).toMatch(/(?:^|\s)gap-1\.5(?:\s|$)/)
    expect(form?.className).toMatch(/(?:^|\s)py-2(?:\s|$)/)
    expect(form?.className).toMatch(/\bflex-col\b/)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
    })
    await waitFor(() => {
      const ta = screen.getByRole('combobox', { name: /^Message$/i })
      expect(ta.textContent).toContain('hello from mic')
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Send$/i })).toBeTruthy()
    })
    // Send takes the primary slot after the transcript lands, but the mic stays
    // mounted so the user can keep dictating on top of the inserted text.
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
    const payload = vi.mocked(window.vyotiq.transcribeDictation).mock.calls[0]![0]
    expect(payload.data).toBeTruthy()
    expect(payload.pcm16k).toBeUndefined()
  })

  it('keeps Dictate usable with a non-empty draft and appends the next transcript', async () => {
    const onDraftChange = vi.fn()
    renderComposer({ draft: 'Summarize this', onDraftChange })

    // Draft has content: Send is primary, but the mic stays mounted for more dictation.
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
    })
    await waitFor(() => {
      const drafts = onDraftChange.mock.calls.map((call) => String(call[0]))
      expect(
        drafts.some((t) => t.includes('Summarize this') && t.includes('hello from mic'))
      ).toBe(true)
    })
  })

  it('preflight blocks recording when the OpenAI key is missing', async () => {
    const { getUserMedia } = installMediaMocks()
    const onOpenSettings = vi.fn()
    renderComposer({
      secrets: emptySecretStatus(),
      slashHandlers: { onOpenSettings }
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/OpenAI API key/i)
    })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(window.vyotiq.transcribeDictation).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Open Providers$/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Open Providers$/i }))
    expect(onOpenSettings).toHaveBeenCalledWith('providers')
  })

  it('keeps attachment chips visible while listening', async () => {
    renderComposer()

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pixels'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)
    const chip = await waitFor(() => screen.getByAltText(/Image 1/i))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true })
    })

    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()
    expect(screen.getByAltText(/Image 1/i)).toBeTruthy()
    expect(document.querySelector('[data-composer-shell]')?.contains(chip)).toBe(true)
  })

  it('keeps the unified toolbar visible with an inline dictation session while listening', async () => {
    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })

    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()
    // The toolbar is NOT replaced — the dictation controls live inside it.
    const toolbar = document.querySelector('[data-composer-toolbar]')
    expect(toolbar).toBeTruthy()
    expect(toolbar?.getAttribute('data-dictation-session')).toBe('listening')
    // Dictation replaces the input — the toolbar fills the row so the waveform
    // expands and the actions right-align.
    expect(toolbar?.className).toMatch(/\bflex-1\b/)
    expect(screen.getByRole('button', { name: /^Stop dictation$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Cancel dictation$/i })).toBeTruthy()
    expect(document.querySelector('[data-composer-git-leading]')).toBeNull()
  })

  it('preflight blocks local dictation when no Whisper model is installed', async () => {
    const { getUserMedia } = installMediaMocks()
    // @ts-expect-error test bridge
    window.vyotiq.getSettings = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...DEFAULT_SETTINGS,
        dictation: { engine: 'local' as const, localModelId: '', waveformStyle: 'bars' as const }
      }
    }))
    const onOpenSettings = vi.fn()
    renderComposer({ slashHandlers: { onOpenSettings } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Whisper model/i)
    })
    expect(getUserMedia).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Open Voice settings$/i }))
    expect(onOpenSettings).toHaveBeenCalledWith('voice')
  })

  it('Cancel on the strip discards without calling transcribe', async () => {
    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel dictation$/i }))
    })

    expect(window.vyotiq.transcribeDictation).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
    expect(screen.queryByRole('status', { name: /Listening/i })).toBeNull()
  })

  it('Escape cancels listening without transcribing', async () => {
    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(window.vyotiq.transcribeDictation).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
  })

  it('inserts the transcript at the caret, not only at the end', async () => {
    function CaretHarness() {
      const [draft, setDraft] = useState('Fix the auth check later')
      return (
        <Composer
          provider="ollama"
          model="qwen2.5"
          running={false}
          hasWorkspace
          secrets={keyedSecrets}
          draft={draft}
          onDraftChange={setDraft}
          chatSettings={chatSettings}
          onChatSettingsChange={vi.fn()}
          onProviderModel={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      )
    }
    render(<CaretHarness />)

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    await act(async () => {
      ta.focus()
    })
    const textNode = ta.firstChild
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE)
    const range = document.createRange()
    range.setStart(textNode as Text, 'Fix the '.length)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    fireEvent.click(ta)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /^Message$/i }).textContent).toBe(
        'Fix the hello from mic auth check later'
      )
    })
  })

  it('shows Stop during a run and still starts dictation via the shortcut', async () => {
    renderComposer({ running: true })
    expect(screen.getByRole('button', { name: /^Stop$/i })).toBeTruthy()
    // Dictate stays reachable mid-run so a follow-up can be composed while the agent runs.
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'm', ctrlKey: true })
    })
    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()
    })
  })

  it('surfaces transcribe errors in the strip with a Providers control', async () => {
    const onOpenSettings = vi.fn()
    // @ts-expect-error test bridge
    window.vyotiq.transcribeDictation = vi.fn(async () => ({
      ok: false as const,
      error: 'Add an OpenAI API key in Settings to use dictation'
    }))

    renderComposer({ slashHandlers: { onOpenSettings } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/OpenAI API key/i)
    })
    fireEvent.click(screen.getByRole('button', { name: /^Open Providers$/i }))
    expect(onOpenSettings).toHaveBeenCalledWith('providers')
  })

  it('ignores an in-flight transcript after Cancel on the transcribing strip', async () => {
    let finish: ((value: { ok: true; data: { text: string } }) => void) | undefined
    // @ts-expect-error test bridge
    window.vyotiq.transcribeDictation = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )

    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(screen.getByRole('status', { name: /Transcribing/i })).toBeTruthy()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel dictation$/i }))
    })
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
    const requestId = vi.mocked(window.vyotiq.transcribeDictation).mock.calls[0]![0].requestId
    expect(requestId).toBeTruthy()
    expect(window.vyotiq.cancelDictation).toHaveBeenCalledWith(requestId)

    await act(async () => {
      finish?.({ ok: true, data: { text: 'late transcript must not insert' } })
    })

    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
    })
    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    expect(ta.textContent ?? '').not.toMatch(/late transcript must not insert/)
  })

  it('includes pcm16k when dictation engine is local', async () => {
    class FakeAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        sampleRate: 16000,
        length: 4,
        duration: 4 / 16000,
        getChannelData: () => new Float32Array([0, 0.5, -0.5, 0])
      }))
      close = vi.fn(async () => undefined)
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    // @ts-expect-error test bridge
    window.vyotiq.getSettings = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...DEFAULT_SETTINGS,
        dictation: {
          engine: 'local' as const,
          localModelId: 'whisper-tiny.en',
          waveformStyle: 'bars' as const
        }
      }
    }))
    // @ts-expect-error test bridge
    window.vyotiq.dictationStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'ready' as const,
        progress: 1,
        message: 'Ready',
        error: null,
        installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41_000_000, loaded: true }],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'local' as const,
        activeModelId: null,
        loadedModelId: 'whisper-tiny.en' as const
      }
    }))
    // @ts-expect-error test bridge
    window.vyotiq.transcribeDictation = vi.fn(async () => ({
      ok: true as const,
      data: { text: 'local transcript' }
    }))

    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
    })
    const payload = vi.mocked(window.vyotiq.transcribeDictation).mock.calls[0]![0]
    expect(payload.data).toBeTruthy()
    expect(payload.pcm16k).toBeTruthy()
    await waitFor(() => {
      const ta = screen.getByRole('combobox', { name: /^Message$/i })
      expect(ta.textContent).toContain('local transcript')
    })
  })

  it('auto-stops and transcribes when recording approaches 25 MB', async () => {
    cleanup()
    vi.unstubAllGlobals()
    installMediaMocks({ largeChunkBytes: MAX_DICTATION_BYTES - 128 * 1024 })
    // @ts-expect-error test bridge
    window.vyotiq = {
      platform: 'win32',
      listModels: vi.fn(async () => ({
        ok: true as const,
        data: { models: [], warning: null }
      })),
      getSettings: vi.fn(async () => ({
        ok: true as const,
        data: DEFAULT_SETTINGS
      })),
      transcribeDictation: vi.fn(async () => ({
        ok: true as const,
        data: { text: 'size-capped transcript' }
      }))
    }

    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
    })
    await waitFor(() => {
      const ta = screen.getByRole('combobox', { name: /^Message$/i })
      expect(ta.textContent).toContain('size-capped transcript')
    })
  })
})
