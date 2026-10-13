import { useEffect, useRef, useState } from 'react'
import { sttEntry } from '@shared/voice'
import { VOICE_STATE_LABEL } from '@shared/voiceSession'
import { Icon } from '@renderer/lib/icons'
import { Button, cn } from '@renderer/lib/ui'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts/match'
import { playEarcon } from './earcons'
import { VoiceOrb } from './VoiceOrb'
import { speakingProblem, voiceProblem } from './voiceCopy'
import { endVoiceMode, setVoiceTarget, startVoiceMode, useVoiceMode, voiceController, voiceModeOwner } from './voiceMode'
import type { VoiceRunTarget } from './turnRouting'

/*
  The voice bar (docs/voice-mode.md §13.2): in place of the instruction
  line's box while voice mode is on. The record stays above it, so what the
  agent says aloud and what it did on screen are one glance apart.

  Row 1 (40px): orb · caption · time · where the audio goes.
  Row 2 (32px): Mute · Stop speaking · Stop the run · hint or problem · End.
*/

function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Shown in the hint row until the first session ends (§13.5). */
export const FIRST_TIP = 'Talk naturally · interrupt any time · headphones work best'
const FIRST_TIP_KEY = 'vyotiq.voice.firstTipSeen'

function firstTipSeen(): boolean {
  try {
    return localStorage.getItem(FIRST_TIP_KEY) === '1'
  } catch {
    return true
  }
}

function markFirstTipSeen(): void {
  try {
    localStorage.setItem(FIRST_TIP_KEY, '1')
  } catch {
    /* blocked storage: the tip shows again next time, which is harmless */
  }
}

/** Esc twice within this window ends voice mode. */
const DOUBLE_ESC_MS = 2000

export function VoiceBar({
  owner,
  workspacePath,
  target,
  onOpenVoiceSettings,
  idleCaption = 'Listening. Talk any time.',
  className
}: {
  owner: string
  workspacePath: string | null
  /** The task this line drives: send, stop and run state, current every render. */
  target: VoiceRunTarget
  onOpenVoiceSettings?: () => void
  /** What the bar says while it listens; the brief asks for the task. */
  idleCaption?: string
  className?: string
}) {
  const { snapshot: v, settings, startedAt: sessionStartedAt } = useVoiceMode()
  const controller = voiceController()
  // The session's clock, not this bar's: it keeps counting when the brief hands over to the task.
  const [mountedAt] = useState(() => Date.now())
  const [showFirstTip] = useState(() => !firstTipSeen())
  const startedAt = sessionStartedAt ?? mountedAt
  const [now, setNow] = useState(() => Date.now())
  const [escArmed, setEscArmed] = useState(false)
  const lastEsc = useRef(0)
  const pttHeld = useRef(false)
  const lastTurn = useRef('')

  // The task's send/stop change every render; keep the store pointed at them.
  setVoiceTarget(owner, target)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    // A bar taking over a running session (brief → task) opens quietly, and
    // one handing it over closes quietly: the session goes on.
    const opening = controller.snapshot.state === 'off' || controller.snapshot.state === 'connecting'
    if (opening) playEarcon('start', settings.earcons)
    return () => {
      if (voiceModeOwner() !== null) return
      playEarcon('end', settings.earcons)
      markFirstTipSeen()
    }
    // Once per session, with the setting as it was when it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A soft sound for a slow step, when spoken progress is off.
  const lastCues = useRef(v.cues)
  useEffect(() => {
    if (v.cues > lastCues.current) playEarcon('work', settings.earcons)
    lastCues.current = v.cues
  }, [v.cues, settings.earcons])

  // A tick when a turn is accepted.
  useEffect(() => {
    if (v.lastTurn && v.lastTurn !== lastTurn.current) {
      lastTurn.current = v.lastTurn
      playEarcon('turn', settings.earcons)
    }
  }, [v.lastTurn, settings.earcons])

  // Keys while the bar is up (§13.6). Capture phase, so Esc here never also stops the run.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (document.querySelector('[aria-expanded="true"][aria-haspopup]')) return
        e.preventDefault()
        e.stopPropagation()
        if (controller.snapshot.state === 'speaking') {
          controller.interrupt()
          return
        }
        const t = Date.now()
        if (t - lastEsc.current < DOUBLE_ESC_MS) {
          void endVoiceMode()
          return
        }
        lastEsc.current = t
        setEscArmed(true)
        setTimeout(() => setEscArmed(false), DOUBLE_ESC_MS)
        return
      }
      // Bare letters and Space belong to any text field, empty or not.
      if (isEditableShortcutTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        controller.setMuted(!controller.snapshot.muted)
        return
      }
      if (e.code === 'Space' && !e.repeat && !pttHeld.current) {
        e.preventDefault()
        pttHeld.current = true
        controller.ptt(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && pttHeld.current) {
        e.preventDefault()
        pttHeld.current = false
        controller.ptt(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [controller])

  const listener = v.listener ? sttEntry(v.listener) : null
  const local = listener?.key.kind === 'none'
  const fellBackFrom = v.listenerFellBackFrom ? sttEntry(v.listenerFellBackFrom) : null
  const problem = v.state === 'error' && v.error ? voiceProblem(v.error) : null
  // An error outside the error state is always the speaking side: the listener's errors end the session.
  const voiceTrouble = v.state !== 'error' && v.error ? speakingProblem(v.error) : null
  const level = v.state === 'speaking' ? () => controller.speakingLevel() : () => controller.snapshot.micLevel

  // Caption: your words while you talk; the agent's while it speaks; else what's happening.
  const caption =
    v.state === 'hearing' && v.partial ? (
      <span className="text-fg">{v.partial}</span>
    ) : v.state === 'speaking' && v.saying ? (
      <span className="text-muted">{v.saying}</span>
    ) : v.lastTurn && (v.state === 'thinking' || v.state === 'working') ? (
      <span className="text-muted">“{v.lastTurn}”</span>
    ) : (
      <span className="text-muted">
        {v.state === 'listening'
          ? idleCaption
          : v.state === 'reconnecting'
            ? `Reconnecting${v.reconnectAttempt > 1 ? ` (try ${v.reconnectAttempt})` : ''}…`
            : VOICE_STATE_LABEL[v.state]}
      </span>
    )

  const hint = escArmed
    ? 'Press Esc again to end voice mode'
    : settings.pushToTalkOnly
      ? 'Hold Space to talk'
      : v.state === 'speaking'
        ? 'Talk to interrupt · Esc stops speaking'
        : showFirstTip
          ? FIRST_TIP
          : 'Hold Space to talk · M mutes'

  return (
    <div
      className={cn('rounded-lg border border-border bg-bg', className)}
      data-voice-open={v.state}
      data-voice-bar
      role="group"
      aria-label="Voice mode"
    >
      {/* State changes are announced; captions are not (they change too fast to be useful read out). */}
      <span className="sr-only" role="status" aria-live="polite">
        {VOICE_STATE_LABEL[v.state]}
      </span>

      <div className="flex h-10 min-w-0 items-center gap-2 pl-3 pr-3" data-voice-row="status">
        <VoiceOrb state={v.state} level={level} />
        <p className="m-0 min-w-0 flex-1 truncate text-sm [direction:rtl] [text-align:left]" data-voice-caption>
          {/* rtl + bdi keeps the newest words in view when the line overflows. */}
          <bdi>{caption}</bdi>
        </p>
        <span className="shrink-0 font-mono text-caption text-tertiary tnum" aria-label="Voice mode time">
          {formatTime(now - startedAt)}
        </span>
        {listener ? (
          <span
            className="flex shrink-0 items-center gap-1 text-caption text-tertiary"
            // Never a silent fallback (§9.5): the listener you picked had no key, so say which one is in use.
            title={fellBackFrom ? `Listening with ${listener.label}: no ${fellBackFrom.label} key. ${listener.privacy}` : listener.privacy}
            data-voice-engine={listener.id}
            data-voice-fell-back={fellBackFrom?.id}
          >
            {fellBackFrom ? (
              <Icon name="warningCircle" size={12} className="text-warning" />
            ) : (
              <Icon name={local ? 'lock' : 'cloud'} size={12} />
            )}
            {listener.label}
            {fellBackFrom ? <span className="sr-only">{`, instead of ${fellBackFrom.label}, which has no key`}</span> : null}
          </span>
        ) : null}
      </div>

      <div className="flex h-8 min-w-0 items-center gap-1 border-t border-border/60 pb-0.5 pl-2 pr-2" data-voice-row="controls">
        <Button
          size="xs"
          variant="ghost"
          icon={v.muted ? 'micSlash' : 'mic'}
          aria-pressed={v.muted}
          disabled={v.state === 'error' || v.state === 'connecting'}
          onClick={() => controller.setMuted(!v.muted)}
        >
          {v.muted ? 'Unmute' : 'Mute'}
        </Button>
        {v.state === 'speaking' ? (
          <Button size="xs" variant="ghost" icon="stop" onClick={() => controller.interrupt()}>
            Stop speaking
          </Button>
        ) : null}
        {target.running() && v.state !== 'speaking' ? (
          <Button size="xs" variant="ghost" icon="stop" onClick={() => void target.stop()}>
            Stop the agent
          </Button>
        ) : null}

        {problem ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-danger" role="alert">
            <Icon name="warningCircle" size={13} className="shrink-0" />
            <span className="truncate">{problem.message}</span>
            {problem.fix === 'settings' && onOpenVoiceSettings ? (
              <Button size="xs" variant="secondary" onClick={onOpenVoiceSettings}>
                Voice settings
              </Button>
            ) : null}
            {problem.fix === 'mic' ? (
              <Button size="xs" variant="secondary" onClick={() => void window.vyotiq.dictationOpenMicSettings?.()}>
                Open mic settings
              </Button>
            ) : null}
            {problem.fix === 'retry' ? (
              <Button size="xs" variant="secondary" onClick={() => void startVoiceMode(owner, { workspacePath })}>
                Try again
              </Button>
            ) : null}
          </span>
        ) : voiceTrouble ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-warning" role="status">
            <Icon name="warningCircle" size={13} className="shrink-0" />
            <span className="truncate">{`${voiceTrouble.message} Replies are on screen.`}</span>
            {voiceTrouble.fix === 'settings' && onOpenVoiceSettings ? (
              <Button size="xs" variant="ghost" onClick={onOpenVoiceSettings}>
                Voice settings
              </Button>
            ) : null}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-caption text-tertiary" aria-live={escArmed ? 'polite' : undefined}>
            {hint}
          </span>
        )}

        <Button size="xs" variant="secondary" icon="close" onClick={() => void endVoiceMode()} data-voice-end>
          End
        </Button>
      </div>
    </div>
  )
}
