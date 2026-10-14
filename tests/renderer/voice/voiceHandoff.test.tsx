/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import {
  HANDOFF_MS,
  beginVoiceHandoff,
  handleVoiceTurn,
  registerVoiceLine,
  resetVoiceModeForTests,
  setVoiceTarget,
  startVoiceMode,
  voiceModeOwner
} from '@renderer/features/voice/voiceMode'
import type { VoiceRunTarget } from '@renderer/features/voice/turnRouting'
import {
  clearComposerAttachments,
  composerAttachmentKey,
  getComposerAttachments,
  setComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'
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

const turn = (text: string) => ({ turnId: 't', text, stop: false })

function briefTarget(owner: string, send = vi.fn(async (_text: string, _opts: { steer: boolean }) => true)): VoiceRunTarget {
  return {
    brief: true,
    running: () => false,
    runId: () => null,
    send: async (text, opts) => {
      beginVoiceHandoff(owner)
      return send(text, opts)
    },
    stop: () => {}
  }
}

function lineTarget(runId: string | null): VoiceRunTarget {
  return { running: () => false, runId: () => runId, send: async () => true, stop: () => {} }
}

beforeEach(async () => {
  await resetVoiceModeForTests(new FakeController())
  window.matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList)
  // The brief reads git, context and tools for its side column: any call it
  // makes beyond these answers "not available".
  const known: Record<string, unknown> = {
    platform: 'win32',
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [], warning: null } }))
  }
  window.vyotiq = new Proxy(known, {
    get: (t, k: string) =>
      k in t ? t[k] : k.startsWith('on') ? () => () => {} : async () => ({ ok: false, error: 'not in this test' })
  }) as never
})

afterEach(async () => {
  vi.useRealTimers()
  cleanup()
  resetWorkspaceHotUiStoreForTests()
  await resetVoiceModeForTests()
})

describe('handing a session from the brief to the new task', () => {
  it('the first line to appear takes the session over, and its run is followed', async () => {
    await startVoiceMode('brief', { workspacePath: '/repo' })
    const send = vi.fn(async (_text: string, _opts: { steer: boolean }) => true)
    setVoiceTarget('brief', briefTarget('brief', send))
    const followed = handleVoiceTurn(turn('add a dark mode toggle'))
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('add a dark mode toggle', { steer: false }))
    registerVoiceLine('line')
    expect(voiceModeOwner()).toBe('line')
    setVoiceTarget('line', lineTarget('run-7'))
    await expect(followed).resolves.toBe('run-7')
  })

  it('a brief that becomes the line in place keeps it; no other line takes it', async () => {
    await startVoiceMode('pane', { workspacePath: '/repo' })
    setVoiceTarget('pane', briefTarget('pane'))
    await handleVoiceTurn({ ...turn('x'), stop: true }) // a stop on the brief sends nothing
    beginVoiceHandoff('pane')
    setVoiceTarget('pane', lineTarget('run-1'))
    registerVoiceLine('split-pane')
    expect(voiceModeOwner()).toBe('pane')
  })

  it('a handoff nobody picked up in time lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await startVoiceMode('brief', { workspacePath: '/repo' })
    beginVoiceHandoff('brief')
    vi.setSystemTime(Date.now() + HANDOFF_MS + 1)
    registerVoiceLine('late')
    expect(voiceModeOwner()).toBe('brief')
  })
})

function renderBrief(onSend = vi.fn(async () => true)) {
  render(
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={false}
      hasWorkspace
      secrets={emptySecretStatus()}
      chatSettings={
        {
          provider: 'ollama',
          model: 'qwen2.5',
          keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
          thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
          thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
          showThinking: DEFAULT_SETTINGS.showThinking
        } as unknown as EffectiveChatSettings
      }
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={onSend}
      variant="brief"
      workspacePath="/repo"
    />
  )
  return onSend
}

describe('voice mode on the New task brief', () => {
  it('offers voice mode, and the bar takes the brief’s place asking for the task', async () => {
    renderBrief()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Talk with the agent' }))
    })
    expect(document.querySelector('[data-voice-bar]')).toBeTruthy()
    expect(document.querySelector('[data-brief]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start task' })).toBeNull()
    expect(screen.getByText('Listening. Say what you want done.')).toBeTruthy()
  })

  it('what you say starts the task', async () => {
    const onSend = renderBrief()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Talk with the agent' }))
    })
    void handleVoiceTurn(turn('rename the config loader'))
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend.mock.calls[0] as unknown[])[0]).toBe('rename the config loader')
    // Marked as said out loud, so its reply opens with a spoken summary (D-32).
    expect((onSend.mock.calls[0] as unknown[])[3]).toEqual({ voice: true })
  })

  it('a spoken start takes every attachment with it, PDFs and audio included, before clearing them (B2)', async () => {
    const key = composerAttachmentKey('/repo', null)!
    const pdf = { type: 'file_native' as const, name: 'spec.pdf', mime: 'application/pdf', data: 'JVBERi0x' }
    const clip = { type: 'audio' as const, url: 'data:audio/wav;base64,UklGRg==', mime: 'audio/wav' }
    setComposerAttachments(key, { images: [], files: [], nativeFiles: [pdf], audio: [clip] })
    const onSend = renderBrief()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Talk with the agent' }))
    })
    void handleVoiceTurn(turn('follow the spec'))
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend.mock.calls[0] as unknown[])[3]).toEqual({ voice: true, nativeFiles: [pdf], audio: [clip] })
    await vi.waitFor(() => expect(getComposerAttachments(key).nativeFiles).toEqual([]))
    clearComposerAttachments(key)
  })
})
