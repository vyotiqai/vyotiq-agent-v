/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MiniVoiceApp } from '@renderer/features/voice/mini/MiniVoiceApp'
import { IDLE_VOICE } from '@renderer/features/voice/voiceSessionController'
import { DEFAULT_VOICE_SETTINGS } from '@shared/ipc/schemas/voice'
import type { VoiceMiniCommand, VoiceMiniState } from '@shared/ipc/schemas/voiceMini'

/*
  The voice mini window (§26.5) draws a mirror of the main window's session
  and sends every click back; it holds nothing of its own.
*/

let push: ((s: VoiceMiniState) => void) | null
let sent: VoiceMiniCommand[]
let resized: boolean[]
let shown: number

beforeEach(() => {
  push = null
  sent = []
  resized = []
  shown = 0
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    platform: 'win32',
    onVoiceMiniState: (h: (s: VoiceMiniState) => void) => {
      push = h
      return () => (push = null)
    },
    onVoiceMiniLevel: () => () => {},
    voiceMiniCommand: (c: VoiceMiniCommand) => sent.push(c),
    voiceMiniResize: ({ open }: { open: boolean }) => resized.push(open),
    voiceMiniShowApp: () => shown++
  }
  window.matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList)
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-skin')
  document.documentElement.removeAttribute('data-theme')
})

function state(over: Partial<typeof IDLE_VOICE> = {}, settings: Record<string, unknown> = {}): VoiceMiniState {
  return {
    snapshot: { ...IDLE_VOICE, state: 'listening', listener: 'openrouter', speaker: 'openrouter', ...over } as unknown as Record<string, unknown>,
    settings: { ...DEFAULT_VOICE_SETTINGS, orbLook: 'simple', ...settings } as unknown as Record<string, unknown>,
    startedAt: Date.now(),
    escArmed: false,
    appearance: { 'data-skin': 'bench', 'data-theme': 'dark' }
  }
}

describe('the voice mini window', () => {
  it('says it is ready, waits for the main window, then draws its session in its look', () => {
    render(<MiniVoiceApp />)
    expect(sent).toEqual([{ kind: 'ready' }])
    sent = []
    expect(document.querySelector('[data-voice-mini]')).toBeNull()
    act(() => push!(state()))
    expect(document.querySelector('[data-voice-mini]')!.getAttribute('data-voice-mini')).toBe('pill')
    expect(document.querySelector('[data-voice-headline]')!.textContent).toBe('Listening')
    // Only the grip moves the window: a drag region gets no pointer events on Windows, so the row must not be one (I9).
    expect(document.querySelector('[data-voice-mini-grip]')!.classList.contains('app-region-drag')).toBe(true)
    expect(document.querySelector('[data-voice-mini-row]')!.classList.contains('app-region-drag')).toBe(false)
    expect(document.documentElement.getAttribute('data-skin')).toBe('bench')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('sends its clicks to the main window', () => {
    render(<MiniVoiceApp />)
    act(() => push!(state()))
    sent = []
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }))
    expect(sent).toEqual([{ kind: 'mute', muted: true }, { kind: 'end' }])
  })

  it('opens into the card while the pointer rests on it, and again while it needs you; the row never moves', () => {
    vi.useFakeTimers()
    try {
      render(<MiniVoiceApp />)
      act(() => push!(state()))
      const mini = document.querySelector('[data-voice-mini]')!
      const row = document.querySelector('[data-voice-mini-row]')
      fireEvent.mouseEnter(mini)
      // Passing over doesn't open it.
      act(() => vi.advanceTimersByTime(100))
      expect(mini.getAttribute('data-voice-mini')).toBe('pill')
      act(() => vi.advanceTimersByTime(300))
      expect(mini.getAttribute('data-voice-mini')).toBe('open')
      expect(resized.at(-1)).toBe(true)
      expect(document.querySelector('[data-voice-mini-row]')).toBe(row)
      // Mute and End are in the row: the card's dock doesn't repeat them.
      expect(screen.getAllByRole('button', { name: 'End voice mode' })).toHaveLength(1)
      expect(screen.queryByRole('button', { name: 'End' })).toBeNull()
      fireEvent.mouseLeave(mini)
      act(() => vi.advanceTimersByTime(500))
      expect(mini.getAttribute('data-voice-mini')).toBe('pill')
      act(() => push!(state({ state: 'waiting_on_you' })))
      expect(mini.getAttribute('data-voice-mini')).toBe('open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('its keys: M mutes, Space held talks, Esc stops it speaking, Esc twice ends', () => {
    render(<MiniVoiceApp />)
    act(() => push!(state()))
    sent = []
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' })
    fireEvent.keyUp(document.body, { key: ' ', code: 'Space' })
    act(() => push!(state({ state: 'speaking' })))
    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => push!(state({ state: 'listening' })))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(sent).toEqual([
      { kind: 'mute', muted: true },
      { kind: 'hold', down: true },
      { kind: 'hold', down: false },
      { kind: 'stop_speaking' },
      { kind: 'end' }
    ])
  })

  it('only the Layout tab: voices and devices belong to the main window', () => {
    vi.useFakeTimers()
    try {
      render(<MiniVoiceApp />)
      act(() => push!(state()))
      sent = []
      fireEvent.mouseEnter(document.querySelector('[data-voice-mini]')!)
      act(() => vi.advanceTimersByTime(400))
      fireEvent.click(screen.getByRole('button', { name: 'Voice, devices and layout' }))
      expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Layout'])
      fireEvent.click(screen.getByRole('radio', { name: /Capsule/ }))
      expect(sent).toEqual([{ kind: 'settings', patch: { placement: 'capsule' } }])
      fireEvent.click(screen.getByRole('button', { name: 'Open in Agent V' }))
      expect(shown).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
