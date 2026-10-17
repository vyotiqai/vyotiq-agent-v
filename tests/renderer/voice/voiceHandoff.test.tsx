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
  ORPHAN_MS,
  HANDOFF_MS,
  beginVoiceHandoff,
  handleVoiceTurn,
  registerVoiceBar,
  registerVoiceLine,
  resetVoiceModeForTests,
  setVoiceAppView,
  setVoiceTarget,
  setVoiceViewOpen,
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
  override get active(): boolean {
    return this.fakeSnap.state !== 'off'
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

describe('the owning line remounting while the session is live', () => {
  // What the real app does after a brief starts a task: the task's line takes
  // over, then remounts as its pane settles, and each mount is a new owner id.
  it('a line that appears after the owner’s bar left takes over, and the run is still followed', async () => {
    await startVoiceMode('brief', { workspacePath: '/repo' })
    setVoiceTarget('brief', briefTarget('brief'))
    const followed = handleVoiceTurn(turn('what branch am I on'))
    await Promise.resolve()
    registerVoiceLine('line-1')()
    expect(voiceModeOwner()).toBe('line-1')
    const bar = registerVoiceBar('line-1')
    setVoiceTarget('line-1', lineTarget(null))
    bar()
    await Promise.resolve()
    registerVoiceLine('line-2')
    expect(voiceModeOwner()).toBe('line-2')
    registerVoiceBar('line-2')
    setVoiceTarget('line-2', lineTarget('run-9'))
    await expect(followed).resolves.toBe('run-9')
  })

  it('a line that appeared just before the owner’s bar left takes over at once', async () => {
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    const bar = registerVoiceBar('line-1')
    registerVoiceLine('line-2')
    expect(voiceModeOwner()).toBe('line-1')
    bar()
    await Promise.resolve()
    expect(voiceModeOwner()).toBe('line-2')
  })

  it('a bar unmounted and remounted in one commit (StrictMode) keeps the session', async () => {
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    registerVoiceLine('line-2')
    registerVoiceBar('line-1')()
    registerVoiceBar('line-1')
    await Promise.resolve()
    expect(voiceModeOwner()).toBe('line-1')
    registerVoiceLine('line-3')
    expect(voiceModeOwner()).toBe('line-1')
  })

  it('a line that has been on screen a while isn’t a remount: the session waits for a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    registerVoiceLine('other-task')
    vi.setSystemTime(Date.now() + HANDOFF_MS + 1)
    const bar = registerVoiceBar('line-1')
    bar()
    await Promise.resolve()
    expect(voiceModeOwner()).toBe('line-1')
    registerVoiceLine('line-1b')
    expect(voiceModeOwner()).toBe('line-1b')
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
    // The voice view opens over it (§26); put away, the bar is in the brief's place.
    expect(document.querySelector('[data-voice-bar]')).toBeNull()
    act(() => setVoiceViewOpen(false))
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

describe('a hand-off the task can’t take says why (R3)', () => {
  it('with no task line to give it to', async () => {
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    await expect(handleVoiceTurn(turn('run the tests'))).resolves.toEqual({ failed: 'no_task' })
  })

  it('when the task refuses the message (not ready to send)', async () => {
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    setVoiceTarget('line-1', { ...lineTarget('run-1'), send: async () => false })
    await expect(handleVoiceTurn(turn('run the tests'))).resolves.toEqual({ failed: 'refused' })
  })

  it('a sent hand-off still resolves to its run', async () => {
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    setVoiceTarget('line-1', lineTarget('run-1'))
    await expect(handleVoiceTurn(turn('run the tests'))).resolves.toBe('run-1')
  })

  it('sent, but its run never reached a line: says so instead of waiting in Thinking (A-112)', async () => {
    vi.useFakeTimers()
    await startVoiceMode('brief', { workspacePath: '/repo' })
    setVoiceTarget('brief', briefTarget('brief'))
    const result = handleVoiceTurn(turn('run the tests'))
    await vi.advanceTimersByTimeAsync(HANDOFF_MS + 1)
    await expect(result).resolves.toEqual({ failed: 'unfollowed' })
  })
})

describe('the voice is told what is on screen (§24.14)', () => {
  it('the task or New task with the line, and Home or Settings when the app moves there', async () => {
    const c = new FakeController()
    await resetVoiceModeForTests(c)
    const setTask = vi.spyOn(c, 'setTask')
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    setVoiceTarget('line-1', lineTarget('run-1'), '/repo')
    await Promise.resolve()
    expect(setTask).toHaveBeenLastCalledWith('run-1', '/repo', 'task')
    setVoiceAppView('settings')
    expect(setTask).toHaveBeenLastCalledWith('run-1', '/repo', 'settings')
    setVoiceAppView('chat')
    expect(setTask).toHaveBeenLastCalledWith('run-1', '/repo', 'task')
    setVoiceTarget('line-1', briefTarget('line-1'), '/repo')
    await Promise.resolve()
    expect(setTask).toHaveBeenLastCalledWith(null, '/repo', 'new_task')
  })
})
