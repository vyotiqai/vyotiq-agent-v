/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState } from 'react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus, MAX_DICTATION_BYTES } from '@shared/ipc'
import type { DictationWaveformStyle } from '@shared/ipc'
import {
  DictationErrorBanner,
  DictationSession,
  Waveform
} from '@renderer/features/chat/components/composer/DictationSessionStrip'
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

  it('shows Dictate when idle, the strip while listening, and the text after transcript', async () => {
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
    expect(strip.className).toMatch(/(?:^|\s)gap-2(?:\s|$)/)
    expect(strip.className).not.toMatch(/\bh-9\b/)
    // Cancel and Stop are the line's quiet icon buttons — no filled accent square.
    const cancel = screen.getByRole('button', { name: /^Cancel dictation$/i })
    const confirm = screen.getByRole('button', { name: /^Stop dictation$/i })
    expect(cancel.className).not.toMatch(/\bbg-accent\b/)
    expect(confirm.className).not.toMatch(/\bbg-accent\b/)
    expect(document.querySelector('[data-composer-shell]')?.className ?? '').not.toMatch(/\bvy-chrome\b/)
    expect(screen.queryByRole('button', { name: /^Dictate$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Instruction' })).toBeNull()
    expect(screen.queryByText('Listening…')).toBeNull()
    // The state word is visible text, not just an aria-label.
    expect(screen.getByText(/^Listening$/)).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Stop dictation$/i }))
    })

    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
    })
    await waitFor(() => {
      const ta = screen.getByRole('combobox', { name: 'Instruction' })
      expect(ta.textContent).toContain('hello from mic')
    })
    // The mic stays so the user can keep dictating on top of the inserted text.
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
    const payload = vi.mocked(window.vyotiq.transcribeDictation).mock.calls[0]![0]
    expect(payload.data).toBeTruthy()
    expect(payload.pcm16k).toBeUndefined()
  })

  it('keeps Dictate usable with a non-empty draft and appends the next transcript', async () => {
    const onDraftChange = vi.fn()
    renderComposer({ draft: 'Summarize this', onDraftChange })

    // Draft has content: the mic stays mounted for more dictation.
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

  it('keeps the row and its options token while a dictation session replaces the field', async () => {
    renderComposer()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })

    const status = screen.getByRole('status', { name: /Listening/i })
    expect(status.getAttribute('data-dictation-session')).toBe('listening')
    // The row is NOT replaced — the session takes the field's place in it.
    const row = document.querySelector('[data-composer-row]')
    expect(row?.contains(status)).toBe(true)
    expect(row?.querySelector('[data-task-options]')).toBeTruthy()
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

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
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
      expect(screen.getByRole('combobox', { name: 'Instruction' }).textContent).toBe(
        'Fix the hello from mic auth check later'
      )
    })
  })

  it('keeps Dictate during a run and still starts dictation via the shortcut', async () => {
    renderComposer({ running: true })
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
    // The strip shows before the request goes out; cancel the request itself,
    // not the moment before it (macos-latest cancelled first).
    await waitFor(() => {
      expect(window.vyotiq.transcribeDictation).toHaveBeenCalled()
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

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
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
      const ta = screen.getByRole('combobox', { name: 'Instruction' })
      expect(ta.textContent).toContain('local transcript')
    })
  })

  it('auto-stops and transcribes when recording approaches 25 MB', async () => {
    cleanup()
    vi.unstubAllGlobals()
    installMediaMocks({ largeChunkBytes: MAX_DICTATION_BYTES - 128 * 1024 })
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
      const ta = screen.getByRole('combobox', { name: 'Instruction' })
      expect(ta.textContent).toContain('size-capped transcript')
    })
  })
})

describe('New task brief dictation', () => {
  /** The brief variant: its own pane, with the checks and context columns. */
  function renderBrief(
    overrides?: Partial<{
      draft: string
      onDraftChange: (draft: string) => void
    }>
  ) {
    return render(
      <Composer
        variant="brief"
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        secrets={keyedSecrets}
        draft={overrides?.draft}
        onDraftChange={overrides?.onDraftChange}
        // The brief's "How it runs" column reads tool approval, which the
        // dock-variant fixture does not carry.
        chatSettings={{ ...chatSettings, toolApproval: DEFAULT_SETTINGS.toolApproval }}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )
  }

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

  it('keeps the brief field mounted while dictating, in an h-8 band', async () => {
    renderBrief()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })

    // The brief's own field is not swapped out for the session row.
    expect(screen.getByRole('combobox', { name: 'Brief' })).toBeTruthy()
    const status = screen.getByRole('status', { name: /Listening/i })
    // The band is a fixed row, not the 132px void the old wrapper left.
    expect(status.className).toMatch(/\bh-8\b/)
    const wrap = document.querySelector('[data-composer-input-wrap]')
    expect(wrap).toBeTruthy()
    expect(status.contains(wrap)).toBe(false)
  })

  it('puts the dictation band above the brief field', async () => {
    renderBrief()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })

    const status = screen.getByRole('status', { name: /Listening/i })
    const wrap = document.querySelector('[data-composer-input-wrap]') as HTMLElement
    expect(
      status.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('cancels from the brief icon row without transcribing', async () => {
    renderBrief()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel dictation$/i }))
    })

    expect(window.vyotiq.transcribeDictation).not.toHaveBeenCalled()
    expect(screen.queryByRole('status', { name: /Listening/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Brief' })).toBeTruthy()
  })

  it('keeps the typed brief readable through a cancelled session', async () => {
    const onDraftChange = vi.fn()
    renderBrief({ draft: 'Wire up the parser', onDraftChange })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Dictate$/i }))
    })
    expect(screen.getByRole('status', { name: /Listening/i })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Brief' }).textContent).toContain(
      'Wire up the parser'
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel dictation$/i }))
    })

    expect(window.vyotiq.transcribeDictation).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Brief' }).textContent).toContain(
      'Wire up the parser'
    )
  })
})

describe('DictationSession', () => {
  const waveformStyles: DictationWaveformStyle[] = ['bars', 'dots', 'line', 'mirror']

  /** Quiet speech-shaped signal: low mean, small amplitude, never flat. */
  const quietSignal = Array.from({ length: 96 }, (_, i) => 0.3 + 0.08 * Math.sin(i))
  const flatSignal = Array.from({ length: 96 }, () => 0.12)

  const phases = [
    { phase: 'checking', label: 'Starting dictation', kind: 'checking', word: 'Starting…' },
    { phase: 'recording', label: 'Listening', kind: 'listening', word: 'Listening' },
    { phase: 'transcribing', label: 'Transcribing', kind: 'transcribing', word: 'Transcribing' }
  ] as const

  /** The flex-1 slot holding the waveform, so assertions skip the phase glyph. */
  function waveSlot(container: HTMLElement): HTMLElement {
    const slot = container.querySelector<HTMLElement>('[data-dictation-session] .min-w-0.flex-1')
    if (!slot) throw new Error('waveform slot not found')
    return slot
  }

  function barHeights(root: HTMLElement): number[] {
    return Array.from(root.querySelectorAll<HTMLElement>('span[style*="height"]')).map((el) =>
      parseFloat(el.style.height)
    )
  }

  /** Class list of the element that owns the bar spans — the Waveform root. */
  function waveToneClass(root: HTMLElement): string {
    return root.querySelector('span[style*="height"]')?.parentElement?.className ?? ''
  }

  it('auto-gains a quiet non-flat signal into a wide bar range', () => {
    const { container } = render(
      <DictationSession phase="recording" elapsedMs={1200} waveform={quietSignal} style="bars" />
    )
    const heights = barHeights(waveSlot(container))
    expect(heights.length).toBeGreaterThan(0)
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThanOrEqual(20)
  })

  it('leaves a flat signal alone instead of stretching it into a block', () => {
    const { container } = render(
      <DictationSession phase="recording" elapsedMs={1200} waveform={flatSignal} style="bars" />
    )
    const heights = barHeights(waveSlot(container))
    expect(heights.length).toBeGreaterThan(0)
    expect(new Set(heights).size).toBe(1)
  })

  it('tones the waveform accent while recording and muted while transcribing', () => {
    const recording = render(<Waveform samples={quietSignal} style="bars" phase="recording" />)
    const transcribing = render(
      <Waveform samples={quietSignal} style="bars" phase="transcribing" />
    )

    const recordingTone = waveToneClass(recording.container)
    expect(recordingTone).toMatch(/\btext-accent\b/)
    expect(recordingTone).not.toMatch(/\btext-muted\b/)

    const transcribingTone = waveToneClass(transcribing.container)
    expect(transcribingTone).toMatch(/\btext-muted\b/)
    expect(transcribingTone).not.toMatch(/\btext-accent\b/)
  })

  it.each(waveformStyles)('renders the %s waveform style', (style) => {
    const { container } = render(
      <DictationSession phase="recording" elapsedMs={0} waveform={quietSignal} style={style} />
    )
    const slot = waveSlot(container)
    if (style === 'line') {
      expect(slot.querySelector('svg path')?.getAttribute('d')).toBeTruthy()
    } else {
      expect(barHeights(slot).length).toBeGreaterThan(0)
    }
  })

  it.each(phases)(
    'exposes the $phase state as a polite status with a visible state word',
    ({ phase, label, kind, word }) => {
      render(
        <DictationSession
          phase={phase}
          elapsedMs={0}
          waveform={quietSignal}
          style="bars"
          engineHint="Whisper small"
        />
      )
      const status = screen.getByRole('status', { name: label })
      expect(status.getAttribute('aria-live')).toBe('polite')
      expect(status.getAttribute('data-dictation-session')).toBe(kind)
      expect(screen.getByText(word)).toBeTruthy()
    }
  )
})

describe('DictationErrorBanner', () => {
  it('pairs the danger text with a warning glyph', () => {
    render(
      <DictationErrorBanner
        message="Microphone permission denied"
        settingsSection={null}
        onDismiss={vi.fn()}
      />
    )
    const alert = screen.getByRole('alert')
    expect(alert.hasAttribute('data-dictation-error')).toBe(true)
    expect(alert.textContent).toContain('Microphone permission denied')
    // Colour never carries meaning alone — the warning glyph rides along.
    const glyph = alert.querySelector('svg')
    expect(glyph).toBeTruthy()
    expect(glyph?.parentElement?.className).toMatch(/\btext-danger\b/)
  })
})
