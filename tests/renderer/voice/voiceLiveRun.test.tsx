/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceTakeoverLayer, VoiceView } from '@renderer/features/voice/VoiceView'
import { handleVoiceTurn, resetVoiceModeForTests, setVoiceTarget, startVoiceMode, voiceController } from '@renderer/features/voice/voiceMode'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'
import type { VoiceRunTarget } from '@renderer/features/voice/turnRouting'
import type { OpenMicCapture } from '@renderer/lib/audio/micCapture'
import type { VoiceEvent, VoiceWork } from '@shared/ipc/schemas/voice'

/*
  Fourth voice audit (docs/voice-mode.md §24.9), the renderer half: a run that
  was already working when voice mode opened, the view's answer buttons
  across two approvals, and a microphone that goes away mid-session.
*/

function bridge() {
  let handler: ((e: VoiceEvent) => void) | null = null
  const b = {
    voiceStart: vi.fn(async () => ({ ok: true, data: { sessionId: 's1' } })),
    voiceStop: vi.fn(async () => ({ ok: true, data: true })),
    voiceAudio: vi.fn(async () => ({ ok: true, data: true })),
    voicePtt: vi.fn(async () => ({ ok: true, data: true })),
    voiceMute: vi.fn(async () => ({ ok: true, data: true })),
    onVoiceEvent: vi.fn((h: (e: VoiceEvent) => void) => {
      handler = h
      return () => {
        handler = null
      }
    }),
    onVoiceAudioOut: vi.fn(() => () => {}),
    voiceFollow: vi.fn(async () => ({ ok: true, data: true })),
    voicePlayback: vi.fn(async () => ({ ok: true, data: true })),
    voiceInterrupt: vi.fn(async () => ({ ok: true, data: true })),
    voiceHandOffFailed: vi.fn(async () => ({ ok: true, data: true }))
  }
  return { b, emit: (e: Record<string, unknown>) => handler?.({ sessionId: 's1', ...e } as VoiceEvent) }
}

function realController(openCapture?: OpenMicCapture) {
  const br = bridge()
  let ended: (() => void) | null = null
  const capture: OpenMicCapture =
    openCapture ??
    (async (o) => {
      ended = o.onEnded ?? null
      return { deviceLabel: 'Headset', deviceId: 'd1', stop: vi.fn() }
    })
  return {
    br,
    endMic: () => ended?.(),
    controller: (onTurn: ConstructorParameters<typeof VoiceSessionController>[0]['onTurn']) =>
      new VoiceSessionController({ bridge: () => br.b as never, openCapture: capture, onTurn })
  }
}

const running = (runId: string): VoiceRunTarget => ({ running: () => true, runId: () => runId, send: vi.fn(async () => true), stop: vi.fn() })

beforeEach(() => {
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    platform: 'win32',
    getSettings: async () => ({ ok: false }),
    onSettingsChanged: () => () => {}
  }
  window.matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList)
})

afterEach(async () => {
  cleanup()
  await resetVoiceModeForTests()
})

describe('voice mode opened on a task that is already working', () => {
  it('follows that run, so its result is spoken and "stop" and "is it done?" reach it', async () => {
    const r = realController()
    await resetVoiceModeForTests(r.controller(handleVoiceTurn))
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    setVoiceTarget('line-1', running('run-9'))
    await vi.waitFor(() => expect(r.br.b.voiceFollow).toHaveBeenCalledWith({ sessionId: 's1', runId: 'run-9' }))
    // Rendering again (the bar does every render) doesn't follow it again.
    setVoiceTarget('line-1', running('run-9'))
    expect(r.br.b.voiceFollow).toHaveBeenCalledTimes(1)
    // The view shows that work, under a line of its own.
    const line = voiceController().snapshot.transcript.find((l) => l.runId === 'run-9')
    expect(line?.who).toBe('agent')
  })

  it('a task that is not working is not followed until something is handed to it', async () => {
    const r = realController()
    await resetVoiceModeForTests(r.controller(handleVoiceTurn))
    await startVoiceMode('line-1', { workspacePath: '/repo' })
    setVoiceTarget('line-1', { running: () => false, runId: () => 'run-1', send: vi.fn(async () => true), stop: vi.fn() })
    await Promise.resolve()
    expect(r.br.b.voiceFollow).not.toHaveBeenCalled()
  })

  it('a hand-off resolves as soon as the task reports its run, without polling', async () => {
    vi.useFakeTimers()
    try {
      const r = realController()
      await resetVoiceModeForTests(r.controller(handleVoiceTurn))
      await startVoiceMode('line-1', { workspacePath: '/repo' })
      let runId: string | null = null
      const t: VoiceRunTarget = { running: () => false, runId: () => runId, send: vi.fn(async () => true), stop: vi.fn() }
      setVoiceTarget('line-1', t)
      const result = handleVoiceTurn({ turnId: 'h1', text: 'Run the tests.', stop: false })
      await vi.advanceTimersByTimeAsync(0)
      runId = 'run-3'
      setVoiceTarget('line-1', t)
      await expect(result).resolves.toBe('run-3')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the microphone going away mid-session', () => {
  it('says so and offers to try again, instead of vanishing', async () => {
    const r = realController()
    const c = r.controller(() => null)
    await c.start()
    act(() => r.endMic())
    await vi.waitFor(() => expect(r.br.b.voiceStop).toHaveBeenCalledWith({ sessionId: 's1' }))
    expect(c.snapshot.state).toBe('error')
    expect(c.snapshot.error).toBe('mic_missing')
    expect(c.active).toBe(false)
  })
})

/** A controller whose snapshot the test sets directly. */
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
  update(next: Partial<VoiceSnapshot>): void {
    this.fakeSnap = { ...this.fakeSnap, ...next }
    for (const s of this.subs) s()
  }
  override async start(): Promise<void> {
    this.update({ state: 'listening' })
  }
  override async stop(): Promise<void> {
    this.update({ ...IDLE_VOICE })
  }
}

const needs = (requestId: string, over: Partial<NonNullable<VoiceWork['ask']>> = {}): VoiceWork => ({
  runId: 'r1',
  state: 'needs',
  startedAt: 0,
  stepCount: 0,
  steps: [],
  ask: { kind: 'approval', requestId, what: 'run git stash', risky: false, ...over } as VoiceWork['ask']
})

describe('answering from the view', () => {
  it('a second approval in the same run gets working buttons again', async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.respondToolApproval = respond
    const fake = new FakeController()
    await resetVoiceModeForTests(fake)
    render(
      <>
        <VoiceView />
        <VoiceTakeoverLayer />
      </>
    )
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    const transcript = [{ id: 'h1', who: 'agent' as const, text: 'Tidy the branch.', runId: 'r1' }]
    act(() => fake.update({ state: 'waiting_on_you', transcript, works: { r1: needs('a1') } }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(respond).toHaveBeenCalledWith('a1', 'once', 'r1')
    act(() => fake.update({ works: { r1: { ...needs('a1'), state: 'running', ask: undefined } } }))
    act(() => fake.update({ works: { r1: needs('a2') } }))
    const allow = screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement
    expect(allow.disabled).toBe(false)
  })

  it('an answer main refused can be given again', async () => {
    const respond = vi.fn(async () => ({ ok: false, error: 'gone' }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.respondToolApproval = respond
    const fake = new FakeController()
    await resetVoiceModeForTests(fake)
    render(
      <>
        <VoiceView />
        <VoiceTakeoverLayer />
      </>
    )
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() => fake.update({ state: 'waiting_on_you', transcript: [{ id: 'h1', who: 'agent', text: 'x', runId: 'r1' }], works: { r1: needs('a1') } }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('offers Always allow only where the voice (and the card) offers it, and says so', async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.respondToolApproval = respond
    const fake = new FakeController()
    await resetVoiceModeForTests(fake)
    render(
      <>
        <VoiceView />
        <VoiceTakeoverLayer />
      </>
    )
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    const transcript = [{ id: 'h1', who: 'agent' as const, text: 'x', runId: 'r1' }]
    act(() => fake.update({ state: 'waiting_on_you', transcript, works: { r1: needs('a1') } }))
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull()
    act(() => fake.update({ works: { r1: needs('a2', { always: true }) } }))
    expect(document.querySelector('[data-voice-subline]')!.textContent).toBe('Say yes, no, or always allow, or use the buttons')
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(respond).toHaveBeenCalledWith('a2', 'always', 'r1')
    act(() => fake.update({ works: { r1: needs('a3', { always: true, risky: true }) } }))
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull()
  })
})
