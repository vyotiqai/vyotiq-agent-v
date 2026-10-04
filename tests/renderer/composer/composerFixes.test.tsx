/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { DictationTranscribeRequest } from '@shared/ipc'
import { resolveEffectiveSettings, type EffectiveChatSettings } from '@shared/effectiveSettings'
import {
  getWorkspaceHotUi,
  resetWorkspaceHotUiStoreForTests,
  setWorkspaceHotComposerDraft
} from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetComposerAttachmentStoreForTests } from '@renderer/lib/hooks/composerAttachmentStore'
import { resetDictationStoreForTests } from '@renderer/features/chat/components/composer/take/dictationStore'

/*
  The six composer fixes, each pinned by the assertion that fails without it:

    1. settingsLocked  — a locked composer in a workspace keeps Mode/Model
                         editable; only a pane with no workspace loses them.
    2. sendBlocked     — an attachment that failed to read blocks Send, and
                         says so with the reason it offers to resolve.
    3. mic lock        — a locked composer's mic is greyed, not live-looking.
    4. take/attach lock— a take owns the field: the attachment chips stop
                         answering while it is writing into them.
    5. draft latch     — a draft prop that changes under one workspace+run is
                         applied, and an empty one never wipes a hot draft.
    6. focus scope     — a send keeps focus in its own pane of a split.
*/

// The only microphone: samples are pushed in as the ScriptProcessor tap would.
const mic = vi.hoisted(() => ({ onSamples: null as ((pcm: Int16Array) => void) | null, opened: 0 }))

vi.mock('@renderer/lib/audio/micCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/audio/micCapture')>()
  return {
    ...actual,
    openMicCapture: vi.fn(async (o: { onSamples: (pcm: Int16Array) => void }) => {
      mic.opened += 1
      mic.onSamples = o.onSamples
      return {
        deviceLabel: 'Test Mic',
        deviceId: 'mic-1',
        stop: () => {
          mic.onSamples = null
        }
      }
    }),
    listMicDevices: vi.fn(async () => [{ deviceId: 'mic-1', label: 'Test Mic' }])
  }
})

// Built from the real defaults so a new setting can't drift this fixture again.
const chatSettings: EffectiveChatSettings = {
  ...resolveEffectiveSettings(DEFAULT_SETTINGS, null),
  provider: 'ollama',
  model: 'qwen2.5'
}

const noop = (): void => {}
const WS = '/ws/fixes'

const RATE = 16000
function tone(ms: number): Int16Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.3 * 32767)
  return out
}
/** Samples in, as the ScriptProcessor tap would deliver them. */
function speak(pcm: Int16Array): void {
  act(() => {
    for (let i = 0; i < pcm.length; i += 2048) mic.onSamples?.(pcm.subarray(i, i + 2048))
  })
}

let replies: string[] = []

beforeEach(() => {
  mic.onSamples = null
  mic.opened = 0
  replies = []
  resetDictationStoreForTests()
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
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          { id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false },
          { id: 'llama3.2', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }
        ],
        warning: null
      }
    })),
    getSettings: vi.fn(async () => ({ ok: true as const, data: DEFAULT_SETTINGS })),
    setSettings: vi.fn(async (patch: Partial<typeof DEFAULT_SETTINGS>) => ({
      ok: true as const,
      data: { ...DEFAULT_SETTINGS, ...patch }
    })),
    transcribeDictation: vi.fn(async (_req: DictationTranscribeRequest) => ({
      ok: true as const,
      data: { text: replies.shift() ?? '' }
    })),
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
  resetWorkspaceHotUiStoreForTests()
  resetComposerAttachmentStoreForTests()
})

type LineProps = Partial<Parameters<typeof Composer>[0]>

function renderLine(overrides: LineProps = {}) {
  const props = {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    running: false,
    hasWorkspace: true,
    secrets: emptySecretStatus(),
    chatSettings,
    onChatSettingsChange: noop,
    onProviderModel: noop,
    onSend: noop,
    variant: 'line' as const,
    ...overrides
  }
  return { props, ...render(<Composer {...props} />) }
}

function picker(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-model-picker]')!
}

function micButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('[data-take-mic]')!
}

function instruction(): HTMLElement {
  // The field is a combobox when editable and a textbox when locked/read-only,
  // so match the element, not the role.
  return document.querySelector<HTMLElement>('[data-composer-input]')!
}

async function startTake(): Promise<void> {
  await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Dictate$/ }))
  })
  await waitFor(() => expect(document.querySelector<HTMLElement>('[data-take]')?.dataset.take).toBe('listening'))
}

describe('composer fix 1 — settings stay editable while the composer is locked', () => {
  it('keeps Mode and Model usable in a locked composer that has a workspace', () => {
    renderLine({ running: true, disabled: true, hasWorkspace: true })
    expect(picker().hasAttribute('disabled')).toBe(false)
    // The field itself is still locked — that is what disabled means.
    expect(instruction().getAttribute('aria-disabled')).toBe('true')
  })

  it('locks Model only where there is no workspace for it to apply to', () => {
    renderLine({ running: false, disabled: true, hasWorkspace: false })
    expect(picker().hasAttribute('disabled')).toBe(true)
  })
})

describe('composer fix 2 — an unreadable attachment blocks Send', () => {
  it('disables Send and offers the reason to resolve', async () => {
    window.vyotiq.extractAttachment = vi.fn(async () => ({
      ok: false as const,
      error: 'scan.pdf has no extractable text (it may be a scan)'
    }))
    const onSend = vi.fn()
    renderLine({ onSend })

    // Something to send — only the attachment is the reason it is refused.
    instruction().textContent = 'read the attachment'
    fireEvent.input(instruction())

    const docs = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(docs, 'files', {
      value: [new File(['scanned'], 'scan.pdf', { type: 'application/pdf' })]
    })
    fireEvent.change(docs)

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('no extractable text')
    )
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send.hasAttribute('disabled')).toBe(true)
    fireEvent.click(send)
    expect(onSend).not.toHaveBeenCalled()
    // The reason a disabled button gives is its tip, not a native title.
    fireEvent.pointerEnter(send.parentElement!)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Resolve the attachment issue before starting.'
    )
  })
})

describe('composer fix 3 — a locked composer greys the mic', () => {
  it('disables [data-take-mic] while the composer is disabled', () => {
    renderLine({ disabled: true })
    expect(micButton().hasAttribute('disabled')).toBe(true)
  })

  it('leaves it live when the composer is not disabled', () => {
    renderLine({ disabled: false })
    expect(micButton().hasAttribute('disabled')).toBe(false)
  })
})

describe('composer fix 4 — a take owns the field', () => {
  const keyed = { ...emptySecretStatus(), openai: true }

  function renderWithAttachment() {
    return render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        workspacePath={WS}
        activeRunId="r1"
        secrets={keyed}
        chatSettings={chatSettings}
        onChatSettingsChange={noop}
        onProviderModel={noop}
        onSend={noop}
        seedFiles={[{ type: 'file', name: 'spec.md', mime: 'text/markdown', text: 'rules here' }]}
      />
    )
  }

  it('locks the attachment chips while the take is open, and unlocks them once it is', async () => {
    renderWithAttachment()
    const remove = () => screen.getByRole('button', { name: 'Remove spec.md' })
    expect(remove().hasAttribute('disabled')).toBe(false)

    await startTake()

    // A take is writing into the field: the chips stop answering.
    expect(remove().hasAttribute('disabled')).toBe(true)
    // The whole control row, the paperclip included, stands aside for the take.
    expect(screen.queryByRole('button', { name: /Attach files/ })).toBeNull()
    // …and the take owns the action: Send waits for the dictation first.
    expect(screen.getByRole('button', { name: /^Insert \(/ })).toBeTruthy()
    replies.push('dictated words')
    speak(tone(900))
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-take]')?.dataset.take).toBe('inserted'))
    // Take over: the chips answer again, and the paperclip is back in the row.
    expect(remove().hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: /Attach files/ })).toBeTruthy()
  })
})

describe('composer fix 5 — the draft prop is not latched to its key', () => {
  function DraftHarness({ draft }: { draft: string }): React.ReactElement {
    return (
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        workspacePath={WS}
        activeRunId="r1"
        draft={draft}
        onDraftChange={noop}
        secrets={emptySecretStatus()}
        chatSettings={chatSettings}
        onChatSettingsChange={noop}
        onProviderModel={noop}
        onSend={noop}
      />
    )
  }

  it('applies a draft that changes under one workspace and run', async () => {
    const { rerender } = render(<DraftHarness draft="" />)
    expect(instruction().textContent).toBe('')

    // Same key, new prop — the run was reloaded, not switched.
    rerender(<DraftHarness draft="first instruction" />)
    await waitFor(() => expect(instruction().textContent).toBe('first instruction'))
    expect(getWorkspaceHotUi(WS).composerDraftByRunId.r1).toBe('first instruction')
  })

  it('never wipes a hot draft with an empty prop', () => {
    setWorkspaceHotComposerDraft(WS, 'r1', 'already typed')
    render(<DraftHarness draft="" />)
    expect(instruction().textContent).toBe('already typed')
    expect(getWorkspaceHotUi(WS).composerDraftByRunId.r1).toBe('already typed')
  })
})

describe('composer fix 6 — a send keeps focus in its own pane', () => {
  it('leaves the left pane’s composer alone when the right one sends', async () => {
    const onSend = vi.fn(async () => true)
    render(
      <>
        <div data-chat-pane data-chat-pane-focused="0">
          <Composer
            provider="ollama"
            model="qwen2.5"
            running={false}
            hasWorkspace
            secrets={emptySecretStatus()}
            chatSettings={chatSettings}
            onChatSettingsChange={noop}
            onProviderModel={noop}
            onSend={onSend}
          />
        </div>
        <div data-chat-pane data-chat-pane-focused="1">
          <Composer
            provider="ollama"
            model="qwen2.5"
            running={false}
            hasWorkspace
            secrets={emptySecretStatus()}
            chatSettings={chatSettings}
            onChatSettingsChange={noop}
            onProviderModel={noop}
            onSend={onSend}
          />
        </div>
      </>
    )
    const [leftPane, rightPane] = Array.from(document.querySelectorAll<HTMLElement>('[data-chat-pane]'))
    const left = within(leftPane).getByRole('combobox', { name: 'Instruction' })
    const right = within(rightPane).getByRole('combobox', { name: 'Instruction' })

    right.textContent = 'ship from the right pane'
    fireEvent.input(right)
    right.focus()
    await act(async () => {
      fireEvent.click(within(rightPane).getByRole('button', { name: 'Send' }))
    })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

    // Focus recovery runs two frames after the send; where it lands is the point.
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
    })
    expect(rightPane.contains(document.activeElement)).toBe(true)
    expect(leftPane.contains(document.activeElement)).toBe(false)
    expect(document.activeElement).toBe(left === document.activeElement ? left : right)
  })
})