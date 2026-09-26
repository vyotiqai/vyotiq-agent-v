/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetWorkspaceHotUiStoreForTests()
})

const chatSettings: EffectiveChatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
}

beforeEach(() => {
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
    getSettings: vi.fn(async () => ({ ok: true as const, data: DEFAULT_SETTINGS }))
  }
})

function renderInline(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    running: false,
    hasWorkspace: true,
    secrets: { ...emptySecretStatus(), openai: true },
    chatSettings,
    onChatSettingsChange: vi.fn(),
    onProviderModel: vi.fn(),
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    onCancelEdit: vi.fn(),
    variant: 'inline' as const,
    draft: 'Fix the parser',
    onDraftChange: vi.fn(),
    composerPlaceholder: 'Edit the instruction…',
    ...overrides
  }
  return { props, ...render(<Composer {...props} />) }
}

describe('Edit and rerun', () => {
  it('draws the instruction line’s controls in the brief’s box, not the chat toolbar', () => {
    renderInline()
    const shell = document.querySelector<HTMLElement>('[data-composer-inline] [data-composer-shell]')!
    expect(shell).toBeTruthy()
    for (const cls of ['rounded-lg', 'border', 'border-border', 'bg-bg', 'focus-within:border-border-strong']) {
      expect(shell.classList.contains(cls)).toBe(true)
    }
    expect(shell.classList.contains('vy-chrome')).toBe(false)

    const row = within(shell)
    expect(row.getByRole('combobox', { name: 'Instruction' })).toBeTruthy()
    expect(row.getByRole('button', { name: 'Attach files — or type @ for context' })).toBeTruthy()
    expect(row.getByRole('button', { name: 'Dictate' })).toBeTruthy()
    expect(shell.querySelector('[data-task-options]')?.textContent).toContain('Agent · qwen2.5')
    expect(row.getByRole('button', { name: 'Rerun' })).toBeTruthy()
    expect(row.getByRole('button', { name: 'Cancel edit' })).toBeTruthy()

    // None of the chat-era toolbar survives.
    expect(screen.queryByRole('button', { name: /^Send$|^Resend$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select model' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Agent mode/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Attach files$/ })).toBeNull()
    expect(document.querySelector('[data-composer-toolbar]')).toBeNull()
  })

  it('reruns on Enter with the edited instruction', async () => {
    const { props } = renderInline()
    const field = screen.getByRole('combobox', { name: 'Instruction' })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('Fix the parser', undefined, undefined, undefined))
  })

  it('reruns from the Rerun button, and cancels from the close button', async () => {
    const { props } = renderInline()
    fireEvent.click(screen.getByRole('button', { name: 'Rerun' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
    expect(props.onCancelEdit).toHaveBeenCalledTimes(1)
  })

  it('cannot rerun an emptied instruction', () => {
    renderInline({ draft: '' })
    expect(screen.getByRole('button', { name: 'Rerun' })).toHaveProperty('disabled', true)
  })

  it('opens the one options popover from its token', async () => {
    renderInline()
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-task-options]')!)
    expect(await screen.findByRole('dialog', { name: 'Mode, model and effort' })).toBeTruthy()
  })

  it('shows a Retry button on a retryable error', () => {
    const onRetryNetwork = vi.fn()
    renderInline({ bannerError: 'Network dropped', errorCode: 'PROVIDER_NETWORK', onRetryNetwork })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryNetwork).toHaveBeenCalledTimes(1)
  })

  it('dictates the way the line does: the session takes the field’s place', async () => {
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
      }
      stop(): void {
        this.state = 'inactive'
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) }
    })
    renderInline()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    })
    const status = await screen.findByRole('status', { name: /Listening/ })
    expect(document.querySelector('[data-composer-row]')?.contains(status)).toBe(true)
    expect(screen.queryByRole('combobox', { name: 'Instruction' })).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
    })
    expect(screen.getByRole('combobox', { name: 'Instruction' })).toBeTruthy()
  })
})
