/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetVoiceModeForTests, startVoiceMode } from '@renderer/features/voice/voiceMode'
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

const chatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
} as unknown as EffectiveChatSettings

beforeEach(async () => {
  await resetVoiceModeForTests(new FakeController())
  window.matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList)
  window.vyotiq = {
    platform: 'win32',
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [], warning: null } }))
  } as never
})

afterEach(async () => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
  await resetVoiceModeForTests()
})

function renderLine(workspacePath: string | null) {
  return render(
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={false}
      hasWorkspace
      secrets={emptySecretStatus()}
      chatSettings={chatSettings}
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={vi.fn()}
      variant="line"
      workspacePath={workspacePath}
    />
  )
}

describe('voice mode on the instruction line', () => {
  it('puts the voice button beside the mic, and swaps the box for the voice bar', async () => {
    renderLine('/repo')
    const row = document.querySelector<HTMLElement>('[data-composer-shell] [data-composer-controls]')!
    const button = within(row).getByRole('button', { name: 'Talk with the agent' })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(document.querySelector('[data-voice-bar]')).toBeTruthy()
    expect(document.querySelector('[data-composer-shell]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(document.querySelector('[data-composer-shell]')).toBeTruthy())
  })

  it('with no listening key, opens “Talk with” instead of starting, and Add key goes to settings', async () => {
    const onOpenSettings = vi.fn()
    window.vyotiq = {
      ...window.vyotiq,
      voiceKeyStatus: vi.fn(async () => ({ ok: true as const, data: { voice: {}, chat: { openai: false, openrouter: false } } }))
    } as never
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        secrets={emptySecretStatus()}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        variant="line"
        workspacePath="/repo"
        slashHandlers={{ onOpenSettings } as never}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Talk with the agent' }))
    })
    const panel = await screen.findByRole('dialog', { name: 'Talk with' })
    expect(document.querySelector('[data-voice-bar]')).toBeNull()
    expect(within(panel).getByText('Deepgram Flux')).toBeTruthy()
    const openai = panel.querySelector<HTMLElement>('[data-voice-setup-choice="openai"]')!
    fireEvent.click(within(openai).getByRole('button', { name: 'Add key' }))
    expect(onOpenSettings).toHaveBeenCalledWith('providers')
  })

  it('starts straight away when a listening key is there', async () => {
    window.vyotiq = {
      ...window.vyotiq,
      voiceKeyStatus: vi.fn(async () => ({
        ok: true as const,
        data: { voice: { deepgram: { set: true, last4: 'abcd' } }, chat: { openai: false, openrouter: false } }
      }))
    } as never
    renderLine('/repo')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Talk with the agent' }))
    })
    await vi.waitFor(() => expect(document.querySelector('[data-voice-bar]')).toBeTruthy())
    expect(screen.queryByRole('dialog', { name: 'Talk with' })).toBeNull()
  })

  it('dictation waits while voice mode is on in another pane', async () => {
    renderLine('/repo')
    const mic = document.querySelector<HTMLButtonElement>('[data-take-mic]')!
    expect(mic.disabled).toBe(false)
    await act(() => startVoiceMode('another-pane', { workspacePath: '/repo' }))
    const waiting = document.querySelector<HTMLButtonElement>('[data-take-mic]')!
    expect(waiting.disabled).toBe(true)
    // Said to screen readers on the button; the tooltip on its wrapper says it on hover.
    expect(waiting.getAttribute('aria-description')).toBe('Voice mode is using the microphone')
  })

  it('has no voice button without a workspace', () => {
    renderLine(null)
    expect(screen.queryByRole('button', { name: 'Talk with the agent' })).toBeNull()
  })
})
