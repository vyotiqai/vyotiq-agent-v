import { describe, expect, it, vi } from 'vitest'
import { VoiceSessionController, type VoiceTurn } from '@renderer/features/voice/voiceSessionController'
import { MicCaptureError, type OpenMicCapture } from '@renderer/lib/audio/micCapture'
import type { VoiceEvent } from '@shared/ipc/schemas/voice'

/** One event kind without its session id (distributes over the union). */
type Bare<E = VoiceEvent> = E extends VoiceEvent ? Omit<E, 'sessionId'> : never

function setup(startResult: unknown = { ok: true, data: { sessionId: 's1' } }) {
  let handler: ((e: VoiceEvent) => void) | null = null
  let onSamples: ((pcm: Int16Array) => void) | null = null
  const stopCapture = vi.fn()
  const bridge = {
    voiceStart: vi.fn(async () => startResult),
    voiceStop: vi.fn(async () => ({ ok: true, data: true })),
    voiceAudio: vi.fn(async () => ({ ok: true, data: true })),
    voicePtt: vi.fn(async () => ({ ok: true, data: true })),
    voiceMute: vi.fn(async () => ({ ok: true, data: true })),
    onVoiceEvent: vi.fn((h: (e: VoiceEvent) => void) => {
      handler = h
      return () => {
        handler = null
      }
    })
  }
  const openCapture: OpenMicCapture = vi.fn(async (o) => {
    onSamples = o.onSamples
    return { deviceLabel: 'Desk mic', deviceId: 'd1', stop: stopCapture }
  })
  const turns: VoiceTurn[] = []
  const c = new VoiceSessionController({
    bridge: () => bridge as never,
    openCapture,
    onTurn: (t) => turns.push(t)
  })
  return {
    c,
    bridge,
    turns,
    stopCapture,
    emit: (e: Bare) => handler?.({ ...e, sessionId: 's1' } as VoiceEvent),
    samples: (pcm: Int16Array) => onSamples?.(pcm),
    openCapture
  }
}

describe('VoiceSessionController', () => {
  it('opens the mic, then the session, and streams audio to it', async () => {
    const t = setup()
    await t.c.start({ workspacePath: '/repo', deviceId: 'd1' })
    expect(t.openCapture).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'd1' }))
    expect(t.bridge.voiceStart).toHaveBeenCalledWith({ workspacePath: '/repo' })
    expect(t.c.snapshot.deviceLabel).toBe('Desk mic')
    const pcm = new Int16Array(2048).fill(4000)
    t.samples(pcm)
    expect(t.bridge.voiceAudio).toHaveBeenCalledWith({ sessionId: 's1', pcm })
    expect(t.c.snapshot.micLevel).toBeGreaterThan(0)
  })

  it('follows state, captions and turns, and hands each turn on', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'hearing' })
    t.emit({ kind: 'partial', text: 'fix the' })
    expect(t.c.snapshot).toMatchObject({ state: 'hearing', partial: 'fix the' })
    t.emit({ kind: 'turn', turnId: 't1', text: 'fix the test', stop: false })
    expect(t.turns).toEqual([{ turnId: 't1', text: 'fix the test', stop: false }])
    expect(t.c.snapshot).toMatchObject({ partial: '', lastTurn: 'fix the test' })
  })

  it('ignores events for another session', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'hearing' })
    const before = t.c.snapshot
    ;(t.bridge.onVoiceEvent.mock.calls[0]![0] as (e: VoiceEvent) => void)({ sessionId: 'other', kind: 'state', state: 'error' })
    expect(t.c.snapshot).toBe(before)
  })

  it('a blocked mic fails before any session is started', async () => {
    const t = setup()
    ;(t.openCapture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new MicCaptureError('blocked', 'denied'))
    await t.c.start()
    expect(t.bridge.voiceStart).not.toHaveBeenCalled()
    expect(t.c.snapshot).toMatchObject({ state: 'error', error: 'mic_blocked' })
  })

  it('a refused start releases the mic and shows the typed error', async () => {
    const t = setup({ ok: false, error: 'x', code: 'voice:no_key' })
    await t.c.start()
    expect(t.stopCapture).toHaveBeenCalled()
    expect(t.c.snapshot).toMatchObject({ state: 'error', error: 'no_key' })
  })

  it('mute stops sending audio; stop releases everything', async () => {
    const t = setup()
    await t.c.start()
    t.c.setMuted(true)
    expect(t.bridge.voiceMute).toHaveBeenCalledWith({ sessionId: 's1', muted: true })
    t.samples(new Int16Array(2048).fill(4000))
    expect(t.bridge.voiceAudio).not.toHaveBeenCalled()
    t.c.ptt(true)
    expect(t.bridge.voicePtt).toHaveBeenCalledWith({ sessionId: 's1', down: true })
    await t.c.stop()
    expect(t.stopCapture).toHaveBeenCalled()
    expect(t.bridge.voiceStop).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(t.c.snapshot.state).toBe('off')
    expect(t.c.active).toBe(false)
  })
})
