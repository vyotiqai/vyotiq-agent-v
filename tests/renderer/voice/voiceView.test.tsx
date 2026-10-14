/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceView } from '@renderer/features/voice/VoiceView'
import { VoiceBar } from '@renderer/features/voice/VoiceBar'
import { resetVoiceModeForTests, setVoiceTarget, startVoiceMode, useVoiceMode } from '@renderer/features/voice/voiceMode'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'
import type { VoiceRunTarget } from '@renderer/features/voice/turnRouting'
import type { VoiceWork, VoiceWorkStep } from '@shared/ipc/schemas/voice'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'

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
}

let fake: FakeController

function target(): VoiceRunTarget & { stop: ReturnType<typeof vi.fn> } {
  return { running: () => true, runId: () => 'r1', send: vi.fn(async () => true), stop: vi.fn() }
}

beforeEach(async () => {
  fake = new FakeController()
  await resetVoiceModeForTests(fake)
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

const view = () => document.querySelector('[data-voice-view]')
const pill = () => document.querySelector('[data-voice-pill]')

describe('the voice view (D-48)', () => {
  it('opens over the pane when voice mode starts, and goes when it ends', async () => {
    render(<VoiceView />)
    expect(view()).toBeNull()
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    expect(view()?.getAttribute('data-voice-view')).toBe('listening')
    expect(document.querySelector('[data-voice-headline]')!.textContent).toBe('Listening')
    expect(document.querySelector('[data-voice-subline]')!.textContent).toBe('Talk any time')
    expect(document.querySelector('[data-voice-engines]')!.textContent).toBe('Hears with OpenRouter · speaks with OpenRouter')
    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    await vi.waitFor(() => expect(view()).toBeNull())
    expect(fake.calls).toContain('stop')
  })

  it('shows the conversation: what you said, what it said, and work it handed to the agent', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'working',
        transcript: [
          { id: 't1', who: 'you', text: 'Run the tests please.' },
          { id: 'c1', who: 'voice', text: 'On it, running them now.' },
          { id: 'h1', who: 'agent', text: 'Run the test suite and report failures.' }
        ]
      })
    )
    const lines = [...document.querySelectorAll('[data-voice-line]')].map((li) => [li.getAttribute('data-voice-line'), li.textContent])
    expect(lines).toEqual([
      ['you', 'YouRun the tests please.'],
      ['voice', 'Agent VOn it, running them now.'],
      ['agent', 'TaskDoingRun the test suite and report failures.']
    ])
    // Working: the headline says so, and the line under it is the work it was given.
    expect(document.querySelector('[data-voice-headline]')!.textContent).toBe('Working on it')
    expect(document.querySelector('[data-voice-subline]')!.textContent).toBe('Run the test suite and report failures.')
  })

  it('a turn of yours split by a pause reads as one; the voice’s separate replies stay apart, named once', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'listening',
        transcript: [
          { id: 't1', who: 'you', text: 'Make a todo file' },
          { id: 't2', who: 'you', text: 'with buy milk in it.' },
          { id: 'c1', who: 'voice', text: 'It wants to change todo.txt. Say yes or no.' },
          { id: 'c2', who: 'voice', text: 'Done, todo.txt is created.' }
        ]
      })
    )
    const lines = [...document.querySelectorAll('[data-voice-line]')].map((li) => li.textContent)
    // The 2026-10-14 probe: the approval prompt and the result a minute later ran together as one paragraph.
    expect(lines).toEqual(['YouMake a todo file with buy milk in it.', 'Agent VIt wants to change todo.txt. Say yes or no.', 'Done, todo.txt is created.'])
  })

  it('your words show as you say them', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() => fake.update({ state: 'hearing', partial: 'can you check the' }))
    expect(document.querySelector('[data-voice-line="partial"]')!.textContent).toContain('can you check the')
  })

  it('Show the task closes it; with no voice bar on screen a small pill keeps it in reach', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(view()).toBeNull()
    expect(pill()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open the voice view' }))
    expect(view()).not.toBeNull()
  })

  it('with the task’s voice bar on screen there’s no pill: the bar offers the view instead', async () => {
    render(
      <>
        <VoiceView />
        <VoiceBar owner="line-1" workspacePath="/repo" target={target()} />
      </>
    )
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show the task' }))
    expect(pill()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Voice view' }))
    expect(view()).not.toBeNull()
  })

  it('its keys work with no voice bar on screen: M mutes, Esc stops speaking, Esc twice ends', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
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
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
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
    // With the dialog gone, Esc is voice mode's again.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByText('Press Esc again to end voice mode')).toBeTruthy()
  })

  it('Space presses a focused button instead of talking; elsewhere it is push-to-talk (R5)', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    const button = screen.getByRole('button', { name: 'Mute' })
    button.focus()
    const pressed = fireEvent.keyDown(button, { key: ' ', code: 'Space' })
    expect(pressed).toBe(true) // not prevented: the button gets its click
    expect(fake.calls.filter((c) => c.startsWith('ptt'))).toEqual([])
    const onBody = fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })
    expect(onBody).toBe(false)
    fireEvent.keyUp(document.body, { key: ' ', code: 'Space' })
    expect(fake.calls.filter((c) => c.startsWith('ptt'))).toEqual(['ptt:true', 'ptt:false'])
  })

  it('a hand-off the task never took reads Not sent, with why, in words (R3)', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() => fake.update({ transcript: [{ id: 'h1', who: 'agent', text: 'Run the tests.', failed: 'refused' }] }))
    const line = document.querySelector('[data-voice-line="agent"]')!
    expect(line.getAttribute('data-voice-work')).toBe('not_sent')
    expect(line.textContent).toContain('Asked')
    expect(line.textContent).toContain('Not sent: the task wasn’t ready to take it')
  })

  it('Stop the task stops the task’s work while it runs', async () => {
    const t = target()
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    setVoiceTarget('line-1', t)
    act(() => fake.update({ state: 'working' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop the task' }))
    await vi.waitFor(() => expect(t.stop).toHaveBeenCalled())
  })

  it('captions off: no words on screen, and it says it still speaks', async () => {
    function CaptionsOff() {
      const { settings } = useVoiceMode()
      return <span data-testid="captions">{String(settings.captions)}</span>
    }
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.getSettings = async () => ({
      ok: true,
      data: { voice: { captions: false } }
    })
    render(
      <>
        <VoiceView />
        <CaptionsOff />
      </>
    )
    await vi.waitFor(() => expect(screen.getByTestId('captions').textContent).toBe('false'))
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    expect(document.querySelector('[data-voice-transcript]')).toBeNull()
    expect(screen.getByText('Captions are off. It still speaks.')).toBeTruthy()
  })

  it('a hand-off shows its run’s live steps, and the line under the orb says the step running now', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'working',
        transcript: [
          { id: 't1', who: 'you', text: 'Run the tests.' },
          { id: 'h1', who: 'agent', text: 'Run the test suite.', runId: 'r1' }
        ],
        works: { r1: work({ steps: [step('a', 'read', 'package.json', 'done'), step('b', 'terminal', 'pnpm test', 'running')], stepCount: 2 }) }
      })
    )
    expect(document.querySelector('[data-voice-work]')!.getAttribute('data-voice-work')).toBe('running')
    const steps = [...document.querySelectorAll('[data-voice-step]')].map((li) => li.getAttribute('data-voice-step'))
    expect(steps).toEqual(['done', 'running'])
    expect(document.querySelector('[data-voice-subline]')!.textContent).toContain('pnpm test')
  })

  it('a run waiting on an approval is answered from the view, as the card would', async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.respondToolApproval = respond
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Tidy the branch.', runId: 'r1' }],
        works: { r1: work({ state: 'needs', ask: { kind: 'approval', requestId: 'q1', what: 'run git stash', risky: false } }) }
      })
    )
    expect(document.querySelector('[data-voice-subline]')!.textContent).toBe('Allow it to run git stash? Say yes or no')
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(respond).toHaveBeenCalledWith('q1', 'once', 'r1')
  })

  it('a risky approval is never a button here: it sends you to the card', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Clean up.', runId: 'r1' }],
        works: { r1: work({ state: 'needs', ask: { kind: 'approval', requestId: 'q1', what: 'run rm -rf build', risky: true } }) }
      })
    )
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Answer on the task' })).toBeTruthy()
  })

  it('a question with a few picks is answered with a click', async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.respondAgentQuestion = respond
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'waiting_on_you',
        transcript: [{ id: 'h1', who: 'agent', text: 'Pick a branch.', runId: 'r1' }],
        works: {
          r1: work({ state: 'needs', ask: { kind: 'question', requestId: 'q2', questionId: 'b', prompt: 'Which branch?', options: ['main', 'dev'] } })
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'dev' }))
    expect(respond).toHaveBeenCalledWith('q2', [{ questionId: 'b', values: ['dev'] }], 'r1')
  })

  it('a finished run shows how it ended and its answer; a second hand-off to the same run carries the work', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'listening',
        transcript: [
          { id: 'h1', who: 'agent', text: 'Fix the test.', runId: 'r1' },
          { id: 'v1', who: 'voice', text: 'Done.' },
          { id: 'h2', who: 'agent', text: 'Also run lint.', runId: 'r1' }
        ],
        works: { r1: work({ state: 'done', endedAt: 61_000, stepCount: 6, result: 'All 14 tests pass.' }) }
      })
    )
    const handOffs = [...document.querySelectorAll('[data-voice-line="agent"]')].map((li) => li.getAttribute('data-voice-work'))
    expect(handOffs).toEqual(['handed', 'done'])
    expect(document.querySelector('[data-voice-result]')!.textContent).toContain('Done in 1 min 01 s · 6 steps')
    expect(document.querySelector('[data-voice-result]')!.textContent).toContain('All 14 tests pass.')
  })

  it('folds an answer only when it is much taller than the fold, however many characters it has', async () => {
    // jsdom lays nothing out: stand in for the answer's rendered height.
    let height = 0
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height)
    try {
      const show = (result: string) =>
        act(() =>
          fake.update({
            state: 'listening',
            transcript: [{ id: 'h1', who: 'agent', text: 'Read it.', runId: 'r1' }],
            works: { r1: work({ state: 'done', endedAt: 9_000, stepCount: 1, result }) }
          })
        )
      height = 120
      const first = render(<VoiceView />)
      await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
      // Long in characters, short on screen (the 2026-10-14 probe: a code block cut through its middle).
      show('The full contents are:\n\n```\nhello\n```\n\n' + 'That is the entire file. '.repeat(14))
      expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull()
      first.unmount()
      height = 600
      render(<VoiceView />)
      show('A long report.')
      fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
      expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      spy.mockRestore()
    }
  })

  it('follows the Layout setting: the orb layout keeps the conversation beside it, the split one shows the task’s steps', async () => {
    let layout = 'orb'
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq.getSettings = async () => ({
      ok: true,
      data: { voice: { viewLayout: layout, orbLook: 'simple' } }
    })
    function Layout() {
      const { settings } = useVoiceMode()
      return <span data-testid="layout">{settings.viewLayout}</span>
    }
    const first = render(
      <>
        <VoiceView />
        <Layout />
      </>
    )
    await vi.waitFor(() => expect(screen.getByTestId('layout').textContent).toBe('orb'))
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() => fake.update({ transcript: [{ id: 't1', who: 'you', text: 'Hello.' }] }))
    expect(view()!.getAttribute('data-voice-layout')).toBe('orb')
    expect(document.querySelector('[data-voice-transcript]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Conversation · 1' }))
    expect(document.querySelector('[data-voice-transcript]')).not.toBeNull()
    first.unmount()

    await resetVoiceModeForTests(fake)
    layout = 'split'
    render(
      <>
        <VoiceView />
        <Layout />
      </>
    )
    await vi.waitFor(() => expect(screen.getByTestId('layout').textContent).toBe('split'))
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    act(() =>
      fake.update({
        state: 'working',
        transcript: [{ id: 'h1', who: 'agent', text: 'Run the tests.', runId: 'r1' }],
        works: { r1: work({ steps: [step('a', 'terminal', 'pnpm test', 'running')], stepCount: 1 }) }
      })
    )
    expect(view()!.getAttribute('data-voice-layout')).toBe('split')
    expect(screen.getByRole('complementary', { name: 'Its task' }).textContent).toContain('pnpm test')

    // A hand-off the task refused: the work pane says so instead of "Handing it over".
    act(() => fake.update({ state: 'listening', transcript: [{ id: 'h2', who: 'agent', text: 'Run lint.', failed: 'no_task' }], works: {} }))
    const pane = screen.getByRole('complementary', { name: 'Its task' })
    expect(pane.textContent).toContain('Not sent')
    expect(pane.textContent).toContain('no task was open to take it')
  })

  it('without WebGL the chosen orb falls back to the drawn one', async () => {
    render(<VoiceView />)
    await act(() => startVoiceMode('line-1', { workspacePath: '/repo' }))
    await vi.waitFor(() => expect(document.querySelector('[data-voice-orb]')).not.toBeNull())
  })
})

function step(id: string, tool: string, summary: string, state: 'running' | 'done' | 'failed'): VoiceWorkStep {
  return { id, tool, summary, state }
}

function work(over: Partial<VoiceWork>): VoiceWork {
  return { runId: 'r1', state: 'running', startedAt: 0, stepCount: 0, steps: [], ...over }
}
