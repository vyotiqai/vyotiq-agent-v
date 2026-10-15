/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FIRST_TIP, VoiceBar } from '@renderer/features/voice/VoiceBar'
import { VoiceModeButton } from '@renderer/features/voice/VoiceModeButton'
import { VoiceOrb } from '@renderer/features/voice/VoiceOrb'
import { VoiceSessionEffects } from '@renderer/features/voice/VoiceView'
import { endVoiceMode, resetVoiceModeForTests, setVoiceViewOpen, startVoiceMode, useVoiceMode } from '@renderer/features/voice/voiceMode'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'
import type { VoiceRunTarget } from '@renderer/features/voice/turnRouting'
import { VOICE_SESSION_STATES } from '@shared/voiceSession'

/** A controller whose snapshot the test sets directly. */
class FakeController extends VoiceSessionController {
  fakeSnap: VoiceSnapshot = { ...IDLE_VOICE }
  subs = new Set<() => void>()
  calls: string[] = []
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
    this.calls.push('start')
    this.update({ state: 'listening', listener: 'deepgram' })
  }
  override async stop(): Promise<void> {
    this.calls.push('stop')
    this.update({ ...IDLE_VOICE })
  }
  override setMuted(m: boolean): void {
    this.calls.push(`mute:${m}`)
    this.update({ muted: m })
  }
  override ptt(down: boolean): void {
    this.calls.push(`ptt:${down}`)
  }
  override interrupt(): void {
    this.calls.push('interrupt')
  }
}

let fake: FakeController

function target(running = false): VoiceRunTarget {
  return { running: () => running, runId: () => 'r1', send: vi.fn(async () => true), stop: vi.fn() }
}

beforeEach(async () => {
  fake = new FakeController()
  await resetVoiceModeForTests(fake)
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    platform: 'win32',
    getSettings: async () => ({ ok: false }),
    onSettingsChanged: () => () => {},
    dictationOpenMicSettings: vi.fn(async () => ({ ok: true, data: true }))
  }
  window.matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList)
})

afterEach(async () => {
  cleanup()
  await resetVoiceModeForTests()
})

/**
 * Voice mode with its view put away ("Show the task"): the bar is the control
 * then (§26; while a placement is open the bar draws nothing).
 */
async function startBar(): Promise<void> {
  await startVoiceMode('line-1', { workspacePath: '/repo' })
  setVoiceViewOpen(false)
}

/** The bar as the app has it: with the session's keys and sounds mounted once beside it (D-48). */
function Bar(props: { owner?: string; running?: boolean; onOpenVoiceSettings?: () => void }) {
  return (
    <>
      <VoiceSessionEffects />
      <VoiceBar
        owner={props.owner ?? 'line-1'}
        workspacePath="/repo"
        target={target(props.running)}
        onOpenVoiceSettings={props.onOpenVoiceSettings}
      />
    </>
  )
}

describe('VoiceOrb', () => {
  it('draws every state, each with its own shape', () => {
    const shapes = new Set<string>()
    for (const s of VOICE_SESSION_STATES) {
      const { container, unmount } = render(<VoiceOrb state={s} />)
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('data-voice-orb')).toBe(s)
      shapes.add(svg.innerHTML.replace(/class="[^"]*"/g, ''))
      unmount()
    }
    // Colour is never the only difference: at least 6 distinct drawings.
    expect(shapes.size).toBeGreaterThanOrEqual(6)
  })
})

describe('VoiceBar', () => {
  it('shows the caption that fits the state and announces the state', async () => {
    await act(() => startBar())
    render(<Bar />)
    expect(screen.getByRole('status').textContent).toBe('Listening')
    expect(document.querySelector('[data-voice-caption]')!.textContent).toBe('Listening. Talk any time.')
    expect(document.querySelector('[data-voice-engine="deepgram"]')!.textContent).toBe('Deepgram Flux')
    act(() => fake.update({ state: 'hearing', partial: 'fix the flaky' }))
    expect(document.querySelector('[data-voice-caption]')!.textContent).toBe('fix the flaky')
    act(() => fake.update({ state: 'speaking', saying: 'I fixed it.' }))
    expect(document.querySelector('[data-voice-caption]')!.textContent).toBe('I fixed it.')
    expect(screen.getByRole('button', { name: 'Stop speaking' })).toBeTruthy()
  })

  it('Esc stops speaking first; twice ends voice mode; it never reaches the app', async () => {
    await act(() => startBar())
    render(<Bar />)
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    act(() => fake.update({ state: 'speaking' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(fake.calls).toContain('interrupt')
    act(() => fake.update({ state: 'listening' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Press Esc again to end voice mode')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(fake.calls).toContain('stop')
    expect(outer).not.toHaveBeenCalled()
    window.removeEventListener('keydown', outer)
  })

  it('M mutes and Space is push-to-talk, but not while typing', async () => {
    await act(() => startBar())
    render(
      <>
        <Bar />
        <input aria-label="elsewhere" />
      </>
    )
    fireEvent.keyDown(window, { key: 'm' })
    expect(fake.calls).toContain('mute:true')
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    fireEvent.keyUp(window, { key: ' ', code: 'Space' })
    expect(fake.calls).toEqual(expect.arrayContaining(['ptt:true', 'ptt:false']))
    const before = fake.calls.length
    fireEvent.keyDown(screen.getByLabelText('elsewhere'), { key: 'm' })
    expect(fake.calls.length).toBe(before)
  })

  it('a missing key says so in words and offers Voice settings', async () => {
    const open = vi.fn()
    await act(() => startBar())
    render(<Bar onOpenVoiceSettings={open} />)
    act(() => fake.update({ state: 'error', error: 'no_key' }))
    expect(screen.getByRole('alert').textContent).toContain('Voice mode needs a key for a listening provider.')
    fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }))
    expect(open).toHaveBeenCalled()
  })

  it('a blocked mic offers the system settings', async () => {
    await act(() => startBar())
    render(<Bar />)
    act(() => fake.update({ state: 'error', error: 'mic_blocked' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open mic settings' }))
    expect(window.vyotiq.dictationOpenMicSettings).toHaveBeenCalled()
  })

  it('a speaking problem is a quiet note: replies stay on screen', async () => {
    await act(() => startBar())
    render(<Bar />)
    act(() => fake.update({ state: 'listening', speakError: { code: 'out_of_credit', detail: '' } }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('[data-voice-row="controls"]')!.textContent).toContain('Replies are on screen.')
  })

  it('shows the provider’s reason after its own words (D-40)', async () => {
    await act(() => startBar())
    render(<Bar />)
    act(() =>
      fake.update({ state: 'error', error: 'out_of_credit', errorDetail: 'OpenRouter (402): requires at least $0.50 in balance' })
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('out of credit.')
    expect(alert.querySelector('[data-voice-problem-detail]')!.textContent).toContain('OpenRouter (402): requires at least $0.50')
  })

  it('a lost turn is a note, not an alarm, and says to say it again (A-03)', async () => {
    await act(() => startBar())
    render(<Bar />)
    act(() => fake.update({ state: 'listening', turnError: { code: 'provider_down', detail: 'OpenRouter (502): bad gateway' } }))
    expect(screen.queryByRole('alert')).toBeNull()
    const row = document.querySelector('[data-voice-row="controls"]')!.textContent
    expect(row).toContain('Say it again.')
    expect(row).toContain('OpenRouter (502): bad gateway')
  })

  it('captions off hides the agent’s words, not its voice (A-09)', async () => {
    const bridge = (window as unknown as { vyotiq: Record<string, unknown> }).vyotiq
    bridge.getSettings = async () => ({ ok: true, data: { voice: { captions: false } } })
    await act(() => startBar())
    act(() => fake.update({ state: 'speaking', saying: 'The tests pass.' }))
    render(<Bar />)
    const caption = document.querySelector('[data-voice-caption]')!.textContent
    expect(caption).not.toContain('The tests pass.')
    expect(caption).toContain('Speaking')
  })

  it('captions on shows the agent’s words', async () => {
    await act(() => startBar())
    act(() => fake.update({ state: 'speaking', saying: 'The tests pass.' }))
    render(<Bar />)
    expect(document.querySelector('[data-voice-caption]')!.textContent).toContain('The tests pass.')
  })

  it('offers Stop the task while it works', async () => {
    await act(() => startBar())
    render(<Bar running />)
    expect(screen.getByRole('button', { name: 'Stop the task' })).toBeTruthy()
  })

  it('says when it listens with another service than the one picked', async () => {
    await act(() => startBar())
    act(() => fake.update({ listener: 'openai', listenerFellBackFrom: 'deepgram' }))
    render(<Bar />)
    const token = document.querySelector<HTMLElement>('[data-voice-engine="openai"]')!
    expect(token.getAttribute('data-voice-fell-back')).toBe('deepgram')
    expect(token.title).toContain('no Deepgram Flux key')
    expect(token.textContent).toContain('Listening with OpenAI: no Deepgram Flux key.')
  })

  it('says when another voice speaks than the one picked, and when none can', async () => {
    await act(() => startBar())
    act(() => fake.update({ speaker: 'openai', speakerFellBackFrom: 'elevenlabs' }))
    render(<Bar onOpenVoiceSettings={vi.fn()} />)
    const token = document.querySelector<HTMLElement>('[data-voice-engine]')!
    expect(token.getAttribute('data-voice-speaker-fell-back')).toBe('elevenlabs')
    expect(token.title).toContain('Speaking with OpenAI: no ElevenLabs key.')
    act(() => fake.update({ speaker: null, speakerFellBackFrom: null }))
    expect(screen.getByText(/No speaking voice has a key/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Voice settings' })).toBeTruthy()
  })

  it('shows the first-use tip until the first session ends', async () => {
    localStorage.removeItem('vyotiq.voice.firstTipSeen')
    await act(() => startBar())
    const first = render(<Bar />)
    expect(screen.getByText(FIRST_TIP)).toBeTruthy()
    await act(() => endVoiceMode())
    first.unmount()
    await act(() => startBar())
    render(<Bar />)
    expect(screen.queryByText(FIRST_TIP)).toBeNull()
    expect(screen.getByText('Hold Space to talk · M mutes')).toBeTruthy()
  })

  it('End ends voice mode', async () => {
    await act(() => startBar())
    render(<Bar />)
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(fake.calls).toContain('stop'))
  })
})

describe('VoiceModeButton', () => {
  function Owner() {
    const { owner } = useVoiceMode()
    return <span data-testid="owner">{owner ?? 'none'}</span>
  }

  it('starts and ends voice mode on its line', async () => {
    render(
      <>
        <VoiceModeButton owner="line-1" workspacePath="/repo" />
        <Owner />
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Talk with the agent' }))
    await vi.waitFor(() => expect(screen.getByTestId('owner').textContent).toBe('line-1'))
    expect(fake.calls).toContain('start')
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }))
    await vi.waitFor(() => expect(screen.getByTestId('owner').textContent).toBe('none'))
  })

  it('the shortcut goes to the line last used, not to every line', async () => {
    render(
      <>
        <VoiceModeButton owner="line-1" workspacePath="/a" />
        <VoiceModeButton owner="line-2" workspacePath="/b" />
        <Owner />
      </>
    )
    fireEvent.focus(screen.getAllByRole('button', { name: 'Talk with the agent' })[0]!)
    fireEvent.keyDown(window, { key: 'M', ctrlKey: true, shiftKey: true })
    await vi.waitFor(() => expect(screen.getByTestId('owner').textContent).toBe('line-1'))
    expect(fake.calls.filter((c) => c === 'start')).toHaveLength(1)
  })
})
