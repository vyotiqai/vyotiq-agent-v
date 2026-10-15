import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { VoiceMiniCommand, VoiceMiniState } from '@shared/ipc/schemas/voiceMini'
import { Icon } from '@renderer/lib/icons'
import { IconButton, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { IDLE_VOICE, type VoiceSnapshot } from '../voiceSessionController'
import { Dock, MuteButton, PopContext, StageContext, usePop, useStage, type StageApi } from '../stage/kit'
import { headline } from '../stage/model'
import { DOUBLE_ESC_MS } from '../VoiceBar'
import { escapeBelongsToALayer, spaceActivates } from '../VoiceView'
import { Card, PillBody } from '../stage/placements'

/*
  The voice mini window's own renderer (docs/voice-mode.md §26.5). It holds
  no session: the main window pushes what to draw (a mirror of its session)
  and every click goes back to it. At rest a pill the size of the window; it
  opens into a card while the pointer rests on it or focus is in it, while a
  popover or the drawer is open, or while the task needs you. The pill's
  row is the card's top row and never moves when it opens, so the control
  under the pointer stays under it.
*/

/** Open after the pointer rests a moment (passing over doesn't open it); close a moment after it leaves. */
const HOVER_OPEN_MS = 300
const HOVER_CLOSE_MS = 400

function send(command: VoiceMiniCommand): void {
  window.vyotiq.voiceMiniCommand?.(command)
}

/** The main window's look: its `<html>` data attributes, replacing any this window had. */
function applyAppearance(attrs: Record<string, string>): void {
  const root = document.documentElement
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.startsWith('data-') && !(attr.name in attrs)) root.removeAttribute(attr.name)
  }
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('data-') && root.getAttribute(name) !== value) root.setAttribute(name, value)
  }
}

function useMirror(): { state: VoiceMiniState | null; level: { current: { level: number; mic: number } } } {
  const [state, setState] = useState<VoiceMiniState | null>(null)
  const level = useRef({ level: 0, mic: 0 })
  useEffect(() => {
    const off = window.vyotiq.onVoiceMiniState?.(setState)
    // Listening now: ask for the state again, in case the first one came before this page did.
    send({ kind: 'ready' })
    return off
  }, [])
  useEffect(
    () =>
      window.vyotiq.onVoiceMiniLevel?.((l) => {
        level.current = l
      }),
    []
  )
  useEffect(() => {
    if (state) applyAppearance(state.appearance)
  }, [state])
  return { state, level }
}

function useMiniStage(state: VoiceMiniState, level: { current: { level: number; mic: number } }): StageApi {
  const readLevel = useMemo(() => () => level.current.level, [level])
  const readMic = useMemo(() => () => level.current.mic, [level])
  return useMemo<StageApi>(() => {
    const v = { ...IDLE_VOICE, ...(state.snapshot as Partial<VoiceSnapshot>) } as VoiceSnapshot
    const settings = { ...DEFAULT_VOICE_SETTINGS, ...(state.settings as Partial<VoiceSettings>) }
    return {
      v,
      settings,
      startedAt: state.startedAt,
      escArmed: state.escArmed,
      level: readLevel,
      micLevel: readMic,
      mute: (muted) => send({ kind: 'mute', muted }),
      hold: (down) => send({ kind: 'hold', down }),
      stopSpeaking: () => send({ kind: 'stop_speaking' }),
      stopTask: () => send({ kind: 'stop_task' }),
      end: () => send({ kind: 'end' }),
      retry: () => send({ kind: 'retry' }),
      // The task's card is in the app: bring it forward.
      showTask: () => window.vyotiq.voiceMiniShowApp?.(),
      openVoiceSettings: () => {
        send({ kind: 'open_settings' })
        window.vyotiq.voiceMiniShowApp?.()
      },
      patchSettings: (patch) => {
        const { placement, style, viewLayout } = patch
        send({ kind: 'settings', patch: { ...(placement ? { placement } : {}), ...(style ? { style } : {}), ...(viewLayout ? { viewLayout } : {}) } })
      },
      respondApproval: (requestId, decision, runId) => {
        send({ kind: 'approval', requestId, decision, runId })
        return Promise.resolve({ ok: true })
      },
      respondQuestion: (requestId, questionId, value, runId) => {
        send({ kind: 'question', requestId, questionId, value, runId })
        return Promise.resolve({ ok: true })
      },
      // Voices and devices live in the main window: only the Layout tab here.
      pickers: false
    }
  }, [state, readLevel, readMic])
}

/** The pill's row, which is also the card's top row: it never moves when the window opens. */
function MiniRow() {
  const api = useStage()
  return (
    // Only the grip moves the window: on Windows a drag region gets no pointer events, so a draggable row would never see the hover that opens the card.
    <div className="flex h-12 shrink-0 items-center gap-2 pr-1.5" data-voice-mini-row role="group" aria-label="Voice mode">
      <span className="app-region-drag flex h-full w-4 shrink-0 cursor-grab items-center justify-center text-tertiary" title="Drag to move" aria-hidden data-voice-mini-grip>
        <Icon name="grip" size={12} />
      </span>
      <PillBody words={140} />
      <span className="flex-1" />
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <MuteButton compact />
      <IconButton icon="close" label="End voice mode" size="sm" onClick={api.end} data-voice-end />
    </div>
  )
}

/**
 * The session's keys, here too: Space held talks, M mutes, Esc stops it
 * speaking, Esc twice ends. The main window's own keys only hear its window.
 */
function useMiniKeys(api: StageApi): void {
  const latest = useRef(api)
  latest.current = api
  useEffect(() => {
    let lastEsc = 0
    let held = false
    const down = (e: KeyboardEvent): void => {
      const a = latest.current
      if (e.key === 'Escape') {
        if (escapeBelongsToALayer()) return
        e.preventDefault()
        if (a.v.state === 'speaking') return a.stopSpeaking()
        const t = Date.now()
        if (t - lastEsc < DOUBLE_ESC_MS) return a.end()
        lastEsc = t
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        a.mute(!a.v.muted)
      } else if (e.code === 'Space' && !e.repeat && !held && !spaceActivates(e.target)) {
        e.preventDefault()
        held = true
        a.hold(true)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || !held) return
      e.preventDefault()
      held = false
      latest.current.hold(false)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [])
}

function MiniWindow() {
  const api = useStage()
  const pop = usePop()
  useMiniKeys(api)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const intend = (on: boolean): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHover(on), on ? HOVER_OPEN_MS : HOVER_CLOSE_MS)
  }
  const open = hover || focus || pop.pop !== 'none' || api.v.state === 'waiting_on_you'
  useEffect(() => {
    window.vyotiq.voiceMiniResize?.({ open })
  }, [open])
  return (
    <PopContext.Provider value={pop}>
      <div
        className={cn('flex h-screen w-screen flex-col overflow-hidden', api.settings.style === 'ambient' ? 'vy-voice-ambient vy-voice-grain' : 'bg-bg')}
        onMouseEnter={() => intend(true)}
        onMouseLeave={() => intend(false)}
        onFocus={() => setFocus(true)}
        onBlur={(e) => setFocus(e.currentTarget.contains(e.relatedTarget as Node | null))}
        data-voice-mini={open ? 'open' : 'pill'}
        data-voice-view={api.v.state}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {headline(api.v)}
        </span>
        <MiniRow />
        {open ? (
          <div className={cn('flex min-h-0 flex-1 flex-col border-t', BORDER_DIVIDER)}>
            <Card
              orb={112}
              head={null}
              dock={
                // Mute and End are in the row above; here the rest, and the way back to the app.
                <Dock compact bare extra={<IconButton icon="external" label="Open in Agent V" size="sm" onClick={() => window.vyotiq.voiceMiniShowApp?.()} />} />
              }
            />
          </div>
        ) : null}
      </div>
    </PopContext.Provider>
  )
}

export function MiniVoiceApp() {
  const { state, level } = useMirror()
  if (!state) return <div className="h-screen w-screen bg-bg" aria-busy="true" />
  return <MiniStage state={state} level={level} />
}

function MiniStage({ state, level }: { state: VoiceMiniState; level: { current: { level: number; mic: number } } }) {
  const api = useMiniStage(state, level)
  return (
    <StageContext.Provider value={api}>
      <MiniWindow />
    </StageContext.Provider>
  )
}
