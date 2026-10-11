/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetVoiceModeForTests } from '@renderer/features/voice/voiceMode'
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

  it('has no voice button without a workspace', () => {
    renderLine(null)
    expect(screen.queryByRole('button', { name: 'Talk with the agent' })).toBeNull()
  })
})
