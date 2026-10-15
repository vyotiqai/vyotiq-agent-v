/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { VoiceCompanionColumn, VoiceTakeoverLayer, VoiceView, voiceSurface } from '@renderer/features/voice/VoiceView'
import { VoiceBar } from '@renderer/features/voice/VoiceBar'
import { registerVoiceLine, resetVoiceModeForTests, setVoiceEscArmed, setVoiceTarget, startVoiceMode, useVoiceMode } from '@renderer/features/voice/voiceMode'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'
import type { VoiceRunTarget } from '@renderer/features/voice/turnRouting'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings, type VoiceWork, type VoiceWorkStep } from '@shared/ipc/schemas/voice'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { resetDictationStoreForTests } from '@renderer/features/chat/components/composer/take/dictationStore'
import { DEFAULT_DICTATION_SETTINGS } from '@shared/ipc'
import { onVoiceConversationsRequest } from '@renderer/features/voice/history/voiceHistoryRequests'

/*
  The redesigned voice view (docs/voice-mode.md §26): five placements over
  one structure, a summary on End. The three slots the app shell mounts are
  rendered together, as the shell has them.
*/

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
    this.update({ state: 'listening', listener: 'openrouter', speaker: 'openrouter' })
  }
  override async stop(): Promise<void> {
    this.calls.push('stop')
    this.update({ ...IDLE_VOICE })
  }
  override setMuted(m: boolean): void {
    this.calls.push(`mute:${m}`)
    this.update({ muted: m })
  }
  override interrupt(): void {
    this.calls.push('interrupt')
  }
  override ptt(down: boolean): void {
    this.calls.push(`ptt:${down}`)
  }
  override setOutput(id: string): void {
    this.calls.push(`output:${id}`)
  }
  mic: string | undefined = undefined
  override get micDeviceId(): string | undefined {
    return this.mic
  }
  override async switchMic(id: string): Promise<boolean> {
    this.calls.push(`mic:${id}`)
    this.mic = id
    return true
  }
}

let fake: FakeController
let setSettings: Mock<(patch: { voice: VoiceSettings }) => Promise<unknown>>

function target(): VoiceRunTarget & { stop: Mock<() => void> } {
  return { running: () => true, runId: () => 'r1', send: vi.fn(async () => true), stop: vi.fn<() => void>() }
}

function bridge(): Record<string, unknown> {
  return (window as unknown as { vyotiq: Record<string, unknown> }).vyotiq
}

beforeEach(async () => {
  fake = new FakeController()
  await resetVoiceModeForTests(fake)
  setSettings = vi.fn(async (patch: { voice: VoiceSettings }) => ({ ok: true, data: { voice: patch.voice } }))
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    platform: 'win32',
    getSettings: async () => ({ ok: false }),
    onSettingsChanged: () => () => {},
    setSettings
  }
  window.matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList)
  localStorage.setItem('vyotiq.voice.firstTipSeen', '1')
})

afterEach(async () => {
  cleanup()
  await resetVoiceModeForTests()
})

/** The three slots, as the app shell mounts them. */
function Shell({ onOpenTask }: { onOpenTask?: (ws: string, run: string) => void }) {
  return (
    <>
      <VoiceView onOpenTask={onOpenTask} />
      <VoiceCompanionColumn />
      <VoiceTakeoverLayer />
    </>
  )
}

function SettingsProbe() {
  const { settings } = useVoiceMode()
  return <span data-testid="settings">{JSON.stringify(settings)}</span>
}

/** Render with these voice settings loaded. */
async function renderWith(voice: Partial<VoiceSettings>, ui = <Shell />) {
  bridge().getSettings = async () => ({ ok: true, data: { voice: { ...DEFAULT_VOICE_SETTINGS, ...voice } } })
  const r = render(
    <>
      {ui}
      <SettingsProbe />
    </>
  )
  await vi.waitFor(() => {
    const s = JSON.parse(screen.getByTestId('settings').textContent!) as VoiceSettings
    for (const [k, v] of Object.entries(voice)) expect(s[k as keyof VoiceSettings]).toEqual(v)
  })
  return r
}

async function start() {
  await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
}

const view = () => document.querySelector('[data-voice-view]')
const placement = () => document.querySelector('[data-voice-placement]')?.getAttribute('data-voice-placement') ?? null
const headline = () => document.querySelector('[data-voice-headline]')!.textContent
const subline = () => document.querySelector('[data-voice-subline]')!.textContent

describe('where voice mode lives (§26)', () => {
  it('picks the surface from the placement, the view being open, and a bar on screen', () => {
    const base = { owner: 'l', ended: null, viewOpen: true, bars: 0 }
    expect(voiceSurface({ ...base, owner: null, settings: { placement: 'takeover' } })).toBeNull()
    expect(voiceSurface({ ...base, settings: { placement: 'inline' } })).toBe('inline')
    expect(voiceSurface({ ...base, settings: { placement: 'companion' } })).toBe('companion')
    expect(voiceSurface({ ...base, settings: { placement: 'takeover' } })).toBe('takeover')
    expect(voiceSurface({ ...base, viewOpen: false, settings: { placement: 'takeover' } })).toBe('capsule')
    expect(voiceSurface({ ...base, viewOpen: false, bars: 1, settings: { placement: 'takeover' } })).toBeNull()
    // The capsule and the mini window are the control: always there, open or not.
    expect(voiceSurface({ ...base, viewOpen: false, bars: 1, settings: { placement: 'capsule' } })).toBe('capsule')
    expect(voiceSurface({ ...base, viewOpen: false, bars: 1, settings: { placement: 'mini' } })).toBe('mini')
  })

  it('Takeover is the default: it opens when voice mode starts and goes when it ends', async () => {
    render(<Shell />)
    expect(view()).toBeNull()
    await start()
    expect(view()?.getAttribute('data-voice-view')).toBe('listening')
    expect(placement()).toBe('takeover')
    // It covers the window, out of the flow: absolute, never also relative (cn() has no merge; the real app showed it beside the pane).
    const layer = screen.getByRole('region', { name: 'Voice mode' })
    expect(layer.classList.contains('absolute')).toBe(true)
    expect(layer.classList.contains('relative')).toBe(false)
    expect(headline()).toBe('Listening')
    expect(subline()).toBe('Say what you want done, or ask about the work')
    // One provider doing both is named once; the whole sentence and where audio goes are its name and tooltip.
    const engines = document.querySelector('[data-voice-engines]')!
    expect(engines.textContent).toBe('OpenRouter')
    expect(engines.getAttribute('aria-label')).toBe('Hears with OpenRouter · speaks with OpenRouter. Audio goes to OpenRouter.')
    // State changes are announced once, by the surface.
    expect(screen.getByRole('status').textContent).toBe('Listening')
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(view()).toBeNull())
    expect(fake.calls).toContain('stop')
    // Nothing was said: nothing to sum up.
    expect(document.querySelector('[data-voice-ended]')).toBeNull()
  })

  it('Takeover follows its layout: Words, Orb, or Split with the task’s steps', async () => {
    await renderWith({ viewLayout: 'split', orbLook: 'simple' })
    await start()
    act(() =>
      fake.update({
        state: 'working',
        transcript: [{ id: 'h1', who: 'agent', text: 'Run the tests.', runId: 'r1' }],
        works: { r1: work({ steps: [step('a', 'terminal', 'pnpm test', 'running')], stepCount: 1 }) }
      })
    )
    expect(document.querySelector('[data-voice-layout]')!.getAttribute('data-voice-layout')).toBe('split')
    expect(screen.getByRole('complementary', { name: 'Its task' }).textContent).toContain('pnpm test')
    // A hand-off the task refused: the pane says so.
    act(() => fake.update({ state: 'listening', transcript: [{ id: 'h2', who: 'agent', text: 'Run lint.', failed: 'no_task' }], works: {} }))
    const pane = screen.getByRole('complementary', { name: 'Its task' })
    expect(pane.textContent).toContain('Not sent: no task was open to take it')
  })

  it('Inline: the voice thread over the task, and the composer as the voice control', async () => {
    await renderWith({ placement: 'inline', orbLook: 'simple' })
    await start()
    expect(placement()).toBe('inline')
    act(() =>
      fake.update({
        state: 'working',
        transcript: [
          { id: 't1', who: 'you', text: 'Run the tests please.' },
          { id: 'c1', who: 'voice', text: 'On it.' },
          { id: 'h1', who: 'agent', text: 'Run the test suite.', runId: 'r1' }
        ],
        works: { r1: work({ steps: [step('a', 'terminal', 'pnpm test', 'running')], stepCount: 1 }) }
      })
    )
    const thread = document.querySelector('[data-voice-transcript]')!
    expect([...thread.querySelectorAll('[data-voice-line]')].map((l) => l.getAttribute('data-voice-line'))).toEqual(['you', 'voice'])
    expect(thread.querySelector('[data-voice-work="running"]')!.textContent).toContain('pnpm test')
    const composer = document.querySelector('[data-voice-composer]')!
    expect(composer.getAttribute('data-voice-composer')).toBe('working')
    expect(composer.textContent).toContain('Working on it…')
    // No orb in Inline: the glow carries the state.
    expect(document.querySelector('[data-voice-glow]')!.getAttribute('data-voice-glow')).toBe('working')
    // Your words as you say them, in the composer.
    act(() => fake.update({ state: 'hearing', partial: 'and then lint' }))
    expect(composer.textContent).toContain('and then lint')
    fireEvent.click(within(composer as HTMLElement).getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(fake.calls).toContain('stop'))
  })

  it('Companion: a column beside the task, dragged to width', async () => {
    await renderWith({ placement: 'companion', orbLook: 'simple' })
    await start()
    expect(placement()).toBe('companion')
    expect(screen.getByRole('separator', { name: 'Resize voice' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Voice mode' })).toBeTruthy()
    // Shrink to a capsule puts it away; with no voice bar on screen the capsule's pill keeps it in reach.
    fireEvent.click(screen.getByRole('button', { name: 'Shrink to a capsule' }))
    expect(placement()).toBe('capsule')
  })

  it('Capsule: a pill that opens into a card, and opens itself to answer', async () => {
    await renderWith({ placement: 'capsule', orbLook: 'simple' })
    await start()
    expect(document.querySelector('[data-voice-capsule]')!.getAttribute('data-voice-capsule')).toBe('pill')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(document.querySelector('[data-voice-capsule]')!.getAttribute('data-voice-capsule')).toBe('card')
    fireEvent.click(screen.getByRole('button', { name: 'Back to the capsule' }))
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Tidy.', runId: 'r1' }],
        works: { r1: work({ state: 'needs', ask: { kind: 'approval', requestId: 'q1', what: 'run git stash', risky: false } }) }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  })

  it('Mini window: opened and mirrored from here; its clicks come back; without it, the capsule', async () => {
    let onCommand: ((c: unknown) => void) | null = null
    const opened: boolean[] = []
    const pushed: unknown[] = []
    Object.assign(bridge(), {
      voiceMiniOpen: vi.fn(async ({ open }: { open: boolean }) => {
        opened.push(open)
        return { ok: true, data: true }
      }),
      voiceMiniPush: (s: unknown) => pushed.push(s),
      voiceMiniPushLevel: () => {},
      onVoiceMiniCommand: (h: (c: unknown) => void) => {
        onCommand = h
        return () => (onCommand = null)
      }
    })
    await renderWith({ placement: 'mini', orbLook: 'simple' })
    await start()
    await vi.waitFor(() => expect(opened).toEqual([true]))
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    expect((pushed.at(-1) as { snapshot: { state: string } }).snapshot.state).toBe('listening')
    // Nothing of it over the app itself: it is in its own window.
    expect(view()).toBeNull()
    act(() => onCommand!({ kind: 'mute', muted: true }))
    expect(fake.calls).toContain('mute:true')
    // Closed from the OS: the app shows the session itself again.
    act(() => onCommand!({ kind: 'closed' }))
    expect(placement()).toBe('capsule')
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }))
    await vi.waitFor(() => expect(opened).toEqual([true, false]))
  })
})

describe('captions and the work', () => {
  it('the current exchange: your turn split by a pause reads as one, and only its newest reply', async () => {
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        transcript: [
          { id: 't1', who: 'you', text: 'Make a todo file' },
          { id: 't2', who: 'you', text: 'with buy milk in it.' },
          { id: 'c1', who: 'voice', text: 'It wants to change todo.txt. Say yes or no.' },
          { id: 'c2', who: 'voice', text: 'Done, todo.txt is created.' }
        ]
      })
    )
    expect(document.querySelector('[data-voice-caption="you"]')!.textContent).toBe('YouMake a todo file with buy milk in it.')
    // "On it." and the result a minute later are two moments, not one paragraph.
    expect(document.querySelector('[data-voice-caption="voice"]')!.textContent).toBe('Done, todo.txt is created.')
    // The history drawer keeps them apart, named once.
    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }))
    const drawer = screen.getByRole('complementary', { name: 'Conversation history' })
    expect([...drawer.querySelectorAll('[data-voice-line]')].map((li) => li.textContent)).toEqual([
      'YouMake a todo file with buy milk in it.',
      'Agent VIt wants to change todo.txt. Say yes or no.',
      'Done, todo.txt is created.'
    ])
    // Esc closes the drawer, and only the drawer.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Conversation history' })).toBeNull()
    expect(screen.queryByText('Press Esc again to end voice mode')).toBeNull()
  })

  it('your words show as you say them, with a caret', async () => {
    render(<Shell />)
    await start()
    act(() => fake.update({ state: 'hearing', partial: 'can you check the' }))
    const you = document.querySelector('[data-voice-caption="you"]')!
    expect(you.textContent).toBe('can you check the')
    expect(you.querySelector('.vy-caret')).not.toBeNull()
  })

  it('its reply is spoken word by word, the way in is to talk over it, and Stop cuts it', async () => {
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'speaking',
        saying: 'It passes now.',
        transcript: [
          { id: 't1', who: 'you', text: 'Is it fixed?' },
          { id: 'v1', who: 'voice', text: 'Yes. It passes now.' }
        ]
      })
    )
    const voice = document.querySelector('[data-voice-caption="voice"]')!
    // The whole reply for a screen reader; the paint is visual.
    expect(voice.querySelector('.sr-only')!.textContent).toBe('Yes. It passes now.')
    expect(voice.querySelector('[data-voice-spoken]')).not.toBeNull()
    expect(document.querySelector('[data-voice-subline] [data-voice-interrupt-cue]')).not.toBeNull()
    expect(subline()).toBe('Talk to interrupt')
    fireEvent.click(screen.getByRole('button', { name: 'Stop speaking' }))
    expect(fake.calls).toContain('interrupt')
    // Main flushed it: the line holds what had played, shown dimmed with a dash.
    act(() => fake.update({ state: 'listening', saying: '', cutLineId: 'v1' }))
    expect(document.querySelector('[data-voice-cut]')!.textContent).toContain('Yes. It passes now. —')
  })

  it('a hand-off shows its last three steps live, and the line under the headline how far it has got', async () => {
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'working',
        transcript: [
          { id: 't1', who: 'you', text: 'Run the tests.' },
          { id: 'h1', who: 'agent', text: 'Run the test suite.', runId: 'r1' }
        ],
        works: {
          r1: work({
            steps: [step('a', 'read', 'package.json', 'done'), step('b', 'read', 'vitest.config.ts', 'done'), step('c', 'grep', 'describe', 'done'), step('d', 'terminal', 'pnpm test', 'running')],
            stepCount: 4
          })
        }
      })
    )
    const strip = document.querySelector('[data-voice-work]')!
    expect(strip.getAttribute('data-voice-work')).toBe('running')
    expect([...strip.querySelectorAll('[data-voice-step]')].map((li) => li.getAttribute('data-voice-step'))).toEqual(['done', 'done', 'running'])
    expect(strip.textContent).toContain('1 earlier in the task')
    // The steps are on screen: the line under the headline says how far, never the brief or the step again.
    expect(subline()).toMatch(/^4 steps · \d/)
    expect(subline()).not.toContain('Run the test suite')
  })

  it('a hand-off the task never took reads Not sent, with why, in words (R3)', async () => {
    render(<Shell />)
    await start()
    act(() => fake.update({ transcript: [{ id: 'h1', who: 'agent', text: 'Run the tests.', failed: 'refused' }] }))
    const strip = document.querySelector('[data-voice-work]')!
    expect(strip.getAttribute('data-voice-work')).toBe('not_sent')
    expect(strip.textContent).toContain('Not sent: the task wasn’t ready to take it')
  })

  it('a finished run shows how it ended and its answer', async () => {
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'listening',
        transcript: [{ id: 'h1', who: 'agent', text: 'Fix the test.', runId: 'r1' }],
        works: { r1: work({ state: 'done', endedAt: 61_000, stepCount: 6, result: 'All 14 tests pass.' }) }
      })
    )
    const strip = document.querySelector('[data-voice-work]')!
    expect(strip.textContent).toContain('6 steps · 1 min 01 s')
    expect(strip.querySelector('[data-voice-result]')!.textContent).toBe('All 14 tests pass.')
  })

  it('captions off: no words on screen, it says it still speaks, and the work stays', async () => {
    await renderWith({ captions: false })
    await start()
    act(() =>
      fake.update({
        state: 'working',
        transcript: [
          { id: 't1', who: 'you', text: 'Run the tests.' },
          { id: 'h1', who: 'agent', text: 'Run the test suite.', runId: 'r1' }
        ],
        works: { r1: work({ stepCount: 0 }) }
      })
    )
    expect(document.querySelector('[data-voice-captions="on"]')).toBeNull()
    expect(screen.getByText('Captions are off. It still speaks.')).toBeTruthy()
    expect(document.querySelector('[data-voice-work]')!.textContent).toContain('Run the test suite.')
  })
})

describe('answering from the view', () => {
  it('a run waiting on an approval is answered as the card would; the line says how to answer', async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    bridge().respondToolApproval = respond
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Tidy the branch.', runId: 'r1' }],
        works: { r1: work({ state: 'needs', ask: { kind: 'approval', requestId: 'q1', what: 'run git stash', risky: false } }) }
      })
    )
    expect(subline()).toBe('Say yes or no, or use the buttons')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(respond).toHaveBeenCalledWith('q1', 'once', 'r1')
  })

  it('a risky approval is never a button here: it sends you to the card', async () => {
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Clean up.', runId: 'r1' }],
        works: { r1: work({ state: 'needs', ask: { kind: 'approval', requestId: 'q1', what: 'run rm -rf build', risky: true } }) }
      })
    )
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Answer on the task' }))
    // Put away to show the task's card; with no voice bar on screen, the capsule's pill stays in reach.
    expect(placement()).toBe('capsule')
  })

  it('a question with a few picks is answered with a click', async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    bridge().respondAgentQuestion = respond
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Pick a branch.', runId: 'r1' }],
        works: { r1: work({ state: 'needs', ask: { kind: 'question', requestId: 'q2', questionId: 'b', prompt: 'Which branch?', options: ['main', 'dev'] } }) }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'dev' }))
    expect(respond).toHaveBeenCalledWith('q2', [{ questionId: 'b', values: ['dev'] }], 'r1')
  })
})

describe('controls and keys', () => {
  it('Mute carries a live level meter, gone while muted; the keys show as keycaps', async () => {
    render(<Shell />)
    await start()
    const mute = screen.getByRole('button', { name: 'Mute' })
    expect(mute.querySelector('[data-voice-meter]')).not.toBeNull()
    expect([...document.querySelectorAll('[data-voice-keys] kbd')].map((k) => k.textContent)).toEqual(['Space', 'M', 'Esc', 'Esc'])
    fireEvent.click(mute)
    expect(fake.calls).toContain('mute:true')
    expect(screen.getByRole('button', { name: 'Unmute' }).querySelector('[data-voice-meter]')).toBeNull()
  })

  it('clicking the orb mutes; pressing and holding it talks', async () => {
    await renderWith({ orbLook: 'sphere' })
    await start()
    const orb = document.querySelector('[data-voice-orb-button]') as HTMLButtonElement
    expect(orb.getAttribute('aria-label')).toBe('Orb')
    fireEvent.click(orb)
    expect(fake.calls).toContain('mute:true')
    expect(orb.getAttribute('aria-pressed')).toBe('true')
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(orb, { button: 0 })
      act(() => vi.advanceTimersByTime(300))
      expect(fake.calls).toContain('ptt:true')
      fireEvent.pointerUp(orb)
      expect(fake.calls).toContain('ptt:false')
      // The click after a hold is the hold's: it doesn't also unmute.
      fireEvent.click(orb)
      expect(fake.calls.filter((c) => c.startsWith('mute'))).toEqual(['mute:true'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('its keys work wherever you are: M mutes, Esc stops speaking, Esc twice ends', async () => {
    render(<Shell />)
    await start()
    fireEvent.keyDown(window, { key: 'm' })
    expect(fake.calls).toContain('mute:true')
    act(() => fake.update({ state: 'speaking' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(fake.calls).toContain('interrupt')
    act(() => fake.update({ state: 'listening' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Press Esc again to end voice mode')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(fake.calls).toContain('stop'))
  })

  it('Esc closes an open dialog first, and never ends voice mode under it (R4)', async () => {
    render(<Shell />)
    await start()
    const onClose = vi.fn()
    function Dialog() {
      useEscapeToClose(onClose, true, { capture: true, deferToMenus: true })
      return (
        <div role="dialog" aria-modal="true">
          <button type="button">Inside</button>
        </div>
      )
    }
    const dlg = render(<Dialog />)
    screen.getByRole('button', { name: 'Inside' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Press Esc again to end voice mode')).toBeNull()
    expect(fake.calls).not.toContain('stop')
    dlg.unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Press Esc again to end voice mode')).toBeTruthy()
  })

  it('Space presses a focused button instead of talking; elsewhere it is push-to-talk (R5)', async () => {
    render(<Shell />)
    await start()
    const button = screen.getByRole('button', { name: 'Mute' })
    button.focus()
    expect(fireEvent.keyDown(button, { key: ' ', code: 'Space' })).toBe(true)
    expect(fake.calls.filter((c) => c.startsWith('ptt'))).toEqual([])
    expect(fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })).toBe(false)
    fireEvent.keyUp(document.body, { key: ' ', code: 'Space' })
    expect(fake.calls.filter((c) => c.startsWith('ptt'))).toEqual(['ptt:true', 'ptt:false'])
  })

  it('Stop the task stops the task’s work while it runs', async () => {
    const t = target()
    render(<Shell />)
    await start()
    setVoiceTarget('line-1', t)
    act(() => fake.update({ state: 'working' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop the task' }))
    await vi.waitFor(() => expect(t.stop).toHaveBeenCalled())
  })

  it('Show the task puts it away: the bar stands in, else the capsule’s pill', async () => {
    const r = render(<Shell />)
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(placement()).toBe('capsule')
    r.unmount()
    await resetVoiceModeForTests(fake)
    render(
      <>
        <Shell />
        <VoiceBar owner="line-1" workspacePath="/repo" target={target()} />
      </>
    )
    await start()
    // While the view is open the bar draws nothing: the view is the control.
    expect(document.querySelector('[data-voice-bar]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(placement()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Voice view' }))
    expect(placement()).toBe('takeover')
  })

  it('one popover for voice, devices and layout; a placement picked there shows at once and is saved', async () => {
    Object.assign(bridge(), { voiceListVoices: vi.fn(async () => ({ ok: true, data: [{ id: 'nova', label: 'Nova' }] })) })
    render(<Shell />)
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'Voice, devices and layout' }))
    const pop = screen.getByRole('dialog', { name: 'Voice settings' })
    expect(within(pop).getByRole('tab', { name: 'Voice' }).getAttribute('aria-selected')).toBe('true')
    await vi.waitFor(() => expect(within(pop).getByRole('radio', { name: /Nova/ })).toBeTruthy())
    fireEvent.click(within(pop).getByRole('tab', { name: 'Layout' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Voice settings' })).getByRole('radio', { name: /Inline/ }))
    await vi.waitFor(() => expect(placement()).toBe('inline'))
    expect((setSettings.mock.calls.at(-1)![0] as { voice: VoiceSettings }).voice.placement).toBe('inline')
  })

  it('Esc closes the popover only, never voice mode under it', async () => {
    render(<Shell />)
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'Voice, devices and layout' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Voice settings' })).toBeNull()
    expect(screen.queryByText('Press Esc again to end voice mode')).toBeNull()
  })

  it('a provider that fell back for want of a key is flagged, with why', async () => {
    render(<Shell />)
    await start()
    act(() => fake.update({ listener: 'openrouter', listenerFellBackFrom: 'deepgram', speaker: 'openrouter' }))
    const engines = document.querySelector('[data-voice-engines]')!
    expect(engines.getAttribute('data-voice-fell-back')).toBe('true')
    expect(engines.getAttribute('aria-label')).toContain('No Deepgram Flux key, so it listens with OpenRouter.')
  })

  it('without WebGL the sphere falls back to the drawn orb', async () => {
    render(<Shell />)
    await start()
    await vi.waitFor(() => expect(document.querySelector('[data-voice-orb]')).not.toBeNull())
  })
})

describe('after End: the summary (§26.7)', () => {
  const said = (): Partial<VoiceSnapshot> => ({
    transcript: [
      { id: 't1', who: 'you', text: 'Fix the test.' },
      { id: 'h1', who: 'agent', text: 'Fix the failing test.', runId: 'r1' },
      { id: 'v1', who: 'voice', text: 'Done, it passes.' },
      { id: 'h2', who: 'agent', text: 'Audit the release notes.', runId: 'r2' }
    ],
    works: {
      r1: work({ state: 'done', endedAt: 61_000, stepCount: 6, result: '## Fixed\nAll 14 tests pass.' }),
      r2: work({ runId: 'r2', steps: [step('a', 'read', 'CHANGELOG.md', 'running')], stepCount: 1 })
    }
  })

  it('always shows, whatever the placement: the outcomes, and two buttons', async () => {
    await renderWith({ placement: 'capsule', orbLook: 'simple' })
    await start()
    act(() => fake.update(said()))
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }))
    await vi.waitFor(() => expect(document.querySelector('[data-voice-ended]')).not.toBeNull())
    expect(fake.calls).toContain('stop')
    expect(document.querySelector('[data-voice-summary-title]')!.textContent).toBe('1 task done · 1 still going')
    const rows = [...document.querySelectorAll('[data-voice-summary-task]')]
    expect(rows.map((r) => r.getAttribute('data-voice-summary-task'))).toEqual(['done', 'running'])
    expect(rows[0]!.textContent).toContain('Fixed')
    expect(rows[0]!.textContent).toContain('1 min 01 s')
    // Its steps froze when the session stopped following it: not shown as live.
    expect(rows[1]!.textContent).toContain('Still going in its task.')
    expect(screen.getByRole('button', { name: 'Talk again' })).toBeTruthy()
    // Nothing live: no Mute.
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull()
    // The conversation, one click away, and back.
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }))
    expect([...document.querySelectorAll('[data-voice-line]')].map((l) => l.getAttribute('data-voice-line'))).toEqual(['you', 'agent', 'voice', 'agent'])
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-voice-summary]')!.getAttribute('data-voice-summary')).toBe('summary')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-voice-ended]')).toBeNull()
  })

  it('a row opens its task and closes the summary', async () => {
    const onOpenTask = vi.fn()
    render(<Shell onOpenTask={onOpenTask} />)
    await start()
    act(() => fake.update(said()))
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(document.querySelector('[data-voice-ended]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Open task: Fix the failing test\./ }))
    expect(onOpenTask).toHaveBeenCalledWith('/repo', 'r1')
    expect(document.querySelector('[data-voice-ended]')).toBeNull()
  })

  it('Talk again starts voice mode on the line you last used', async () => {
    const commands: string[] = []
    const onCommand = (e: Event) => commands.push((e as CustomEvent<{ id: string }>).detail.id)
    window.addEventListener('vyotiq:command', onCommand)
    const off = registerVoiceLine('line-1')
    try {
      render(<Shell />)
      await start()
      act(() => fake.update(said()))
      fireEvent.click(screen.getByRole('button', { name: 'End' }))
      await vi.waitFor(() => expect(document.querySelector('[data-voice-ended]')).not.toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Talk again' }))
      expect(commands).toEqual(['voiceMode'])
      expect(document.querySelector('[data-voice-ended]')).toBeNull()
    } finally {
      off()
      window.removeEventListener('vyotiq:command', onCommand)
    }
  })

  it('Talk again with no task line on screen keeps the summary and says what to do', async () => {
    render(<Shell />)
    await start()
    act(() => fake.update(said()))
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(document.querySelector('[data-voice-ended]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Talk again' }))
    expect(document.querySelector('[data-voice-ended]')).not.toBeNull()
    expect(document.querySelector('[data-voice-talk-again-none]')!.textContent).toContain('Open a task or New task first')
  })

  it('talking again replaces it', async () => {
    render(<Shell />)
    await start()
    act(() => fake.update(said()))
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(document.querySelector('[data-voice-ended]')).not.toBeNull())
    await start()
    expect(document.querySelector('[data-voice-ended]')).toBeNull()
    expect(view()).not.toBeNull()
  })

  it('All voice conversations opens the saved copies of this workspace', async () => {
    const opened: Array<[string, string | null]> = []
    const off = onVoiceConversationsRequest((ws, id) => opened.push([ws, id]))
    try {
      render(<Shell />)
      await start()
      act(() => fake.update({ transcript: [{ id: 't1', who: 'you', text: 'Hello.' }] }))
      fireEvent.click(screen.getByRole('button', { name: 'End' }))
      await vi.waitFor(() => expect(document.querySelector('[data-voice-ended]')).not.toBeNull())
      expect(document.querySelector('[data-voice-summary-title]')!.textContent).toBe('Nothing handed over')
      fireEvent.click(screen.getByRole('button', { name: 'All voice conversations' }))
      expect(opened).toEqual([['/repo', null]])
      expect(document.querySelector('[data-voice-ended]')).toBeNull()
    } finally {
      off()
    }
  })
})

describe('audit 2026-10-15 (I3–I16)', () => {
  it('Voice settings from a covering placement steps it aside, so the settings are seen', async () => {
    const onOpen = vi.fn()
    render(
      <>
        <VoiceView onOpenVoiceSettings={onOpen} />
        <VoiceTakeoverLayer onOpenVoiceSettings={onOpen} />
      </>
    )
    await start()
    fireEvent.click(document.querySelector('[data-voice-engines]')!)
    expect(onOpen).toHaveBeenCalled()
    expect(placement()).toBe('capsule')
  })

  it('the pill standing in for a put-away placement opens that placement, not a capsule card', async () => {
    render(<Shell />)
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(placement()).toBe('capsule')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(placement()).toBe('takeover')
  })

  it('a placement picked in Settings shows at once, even when the old one was put away', async () => {
    let changed: ((s: { voice: VoiceSettings }) => void) | null = null
    bridge().onSettingsChanged = (h: (s: { voice: VoiceSettings }) => void) => {
      changed = h
      return () => {}
    }
    render(<Shell />)
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(placement()).toBe('capsule')
    act(() => changed!({ voice: { ...DEFAULT_VOICE_SETTINGS, placement: 'companion' } }))
    expect(placement()).toBe('companion')
  })

  it('Esc pressed once says so in placements that show no keys (Companion)', async () => {
    await renderWith({ placement: 'companion', orbLook: 'simple' })
    await start()
    act(() => setVoiceEscArmed(true))
    expect(subline()).toBe('Press Esc again to end voice mode')
  })

  it('what a covering placement covers is inert, focus moves onto it, and it comes back when it goes', async () => {
    render(
      <div>
        <button type="button">Under it</button>
        <Shell />
      </div>
    )
    screen.getByRole('button', { name: 'Under it' }).focus()
    await start()
    const under = screen.getByText('Under it')
    expect(under.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Voice mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(under.hasAttribute('inert')).toBe(false)
  })

  it('the history drawer opens on the newest lines', async () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    try {
      render(<Shell />)
      await start()
      act(() => fake.update({ transcript: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, who: 'you' as const, text: `Line ${i}.` })) }))
      fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }))
      const list = screen.getByRole('complementary', { name: 'Conversation history' }).querySelector('.overflow-y-auto') as HTMLElement
      expect(list.scrollTop).toBe(900)
    } finally {
      spy.mockRestore()
    }
  })

  it('the reply being spoken is lit word by word even when its caption carries edge spaces', async () => {
    render(<Shell />)
    await start()
    act(() =>
      fake.update({
        state: 'speaking',
        saying: ' It passes now. ',
        transcript: [
          { id: 't1', who: 'you', text: 'Is it fixed?' },
          { id: 'v1', who: 'voice', text: 'Yes. It passes now.' }
        ]
      })
    )
    expect(document.querySelector('[data-voice-caption="voice"] [data-voice-spoken]')).not.toBeNull()
  })

  it('the Voice tab says it is finding out who speaks before the session has said', async () => {
    render(<Shell />)
    await start()
    act(() => fake.update({ speaker: undefined }))
    fireEvent.click(screen.getByRole('button', { name: 'Voice, devices and layout' }))
    expect(document.querySelector('[data-voice-voices]')!.getAttribute('data-voice-voices')).toBe('loading')
    act(() => fake.update({ speaker: null }))
    expect(document.querySelector('[data-voice-voices]')!.getAttribute('data-voice-voices')).toBe('none')
  })

  it('the mic picked in Settings (it is dictation’s too) is the one the live session listens on (I10)', async () => {
    let changed: ((s: Record<string, unknown>) => void)[] = []
    bridge().onSettingsChanged = (h: (s: Record<string, unknown>) => void) => {
      changed.push(h)
      return () => {
        changed = changed.filter((x) => x !== h)
      }
    }
    resetDictationStoreForTests()
    render(<Shell />)
    await start()
    act(() => {
      for (const h of changed) h({ dictation: { ...DEFAULT_DICTATION_SETTINGS, deviceId: 'headset-mic' } })
    })
    await vi.waitFor(() => expect(fake.calls).toContain('mic:headset-mic'))
    resetDictationStoreForTests()
  })

  it('the Companion is never wider than half the window', async () => {
    await renderWith({ placement: 'companion', orbLook: 'simple' })
    await start()
    const column = document.querySelector('[data-voice-placement="companion"]') as HTMLElement
    expect(column.style.maxWidth).toBe('50vw')
  })
})

function step(id: string, tool: string, summary: string, state: 'running' | 'done' | 'failed'): VoiceWorkStep {
  return { id, tool, summary, state }
}

function work(over: Partial<VoiceWork>): VoiceWork {
  return { runId: 'r1', state: 'running', startedAt: 0, stepCount: 0, steps: [], ...over }
}
