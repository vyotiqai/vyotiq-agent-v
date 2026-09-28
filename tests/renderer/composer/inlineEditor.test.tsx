/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetDictationStoreForTests } from '@renderer/features/chat/components/composer/take/dictationStore'

vi.mock('@renderer/lib/audio/micCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/audio/micCapture')>()
  return {
    ...actual,
    openMicCapture: vi.fn(async () => ({ deviceLabel: 'Test Mic', deviceId: 'mic-1', stop: vi.fn() }))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetWorkspaceHotUiStoreForTests()
  resetDictationStoreForTests()
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
    // The line's control row: mode, model, then the edit's own two actions.
    expect(row.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy()
    expect(shell.querySelector('[data-model-picker]')?.textContent).toContain('qwen2.5')
    expect(row.getByRole('button', { name: 'Rerun' }).textContent).toContain('Rerun')
    expect(row.getByRole('button', { name: 'Cancel edit' }).textContent).toContain('Cancel')
    // No usage reported yet: no context reading.
    expect(shell.querySelector('[data-context-meter]')).toBeNull()

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

  it('carries the context reading, since the line is hidden while an edit is open', () => {
    renderInline({
      contextUsage: {
        step: 3,
        used: 4000,
        estimatedTokens: 4000,
        inputTokens: 4000,
        window: 32768,
        contentWindow: 27852,
        compactionTrigger: 27852,
        source: 'provider',
        layers: { system: 1000, history: 3000, tools: 0, buffer: 0 },
        stepUsage: {
          inputTokens: 4000,
          billedInputTokens: 9000,
          peakInputTokens: 4000,
          outputTokens: 120,
          cachedInputTokens: 0,
          billedCachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          steps: 3,
          stepsWithCacheReport: 0,
          billedCost: 0,
          billedCostSaved: 0,
          stepsWithCostReport: 0,
          estimatedCost: 0,
          stepsWithEstimate: 0,
          generationMs: 0
        },
        updatedAt: '2026-01-01T12:00:00.000Z'
      }
    })
    const shell = document.querySelector<HTMLElement>('[data-composer-inline] [data-composer-shell]')!
    expect(shell.querySelector('[data-composer-controls] [data-context-meter]')).toBeTruthy()
  })

  it('opens the model picker from its trigger', async () => {
    renderInline()
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-model-picker]')!)
    expect(await screen.findByRole('dialog', { name: 'Model and effort' })).toBeTruthy()
  })

  it('shows a Retry button on a retryable error', () => {
    const onRetryNetwork = vi.fn()
    renderInline({ bannerError: 'Network dropped', errorCode: 'PROVIDER_NETWORK', onRetryNetwork })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryNetwork).toHaveBeenCalledTimes(1)
  })

  it('dictates the way the line does: the field stays, the take strip sits in the box', async () => {
    renderInline()
    await waitFor(() => expect(window.vyotiq.getSettings).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    })
    await waitFor(() => expect(document.querySelector('[data-take="listening"]')).toBeTruthy())
    const strip = document.querySelector('[data-take="listening"]') as HTMLElement
    expect(document.querySelector('[data-composer-inline] [data-composer-shell]')?.contains(strip)).toBe(true)
    // The instruction being edited stays in view, read-only for the take.
    const field = screen.getByRole('textbox', { name: 'Instruction' })
    expect(field.textContent).toBe('Fix the parser')
    expect(within(strip).getByRole('button', { name: /Rerun/ })).toBeTruthy()

    // Esc discards the take — it does not cancel the edit.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-take="discarded"]')).toBeTruthy())
    expect(screen.getByRole('combobox', { name: 'Instruction' })).toBeTruthy()
  })
})
