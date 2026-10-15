import { useEffect, useMemo, useState } from 'react'
import { sttEntry, ttsEntry } from '@shared/voice'
import { VOICE_STATE_LABEL } from '@shared/voiceSession'
import { Icon } from '@renderer/lib/icons'
import { Button, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { VoiceOrb } from './VoiceOrb'
import { speakingProblem, turnProblem, voiceProblem, type VoiceProblem } from './voiceCopy'
import { endVoiceMode, registerVoiceBar, setVoiceTarget, setVoiceViewOpen, startVoiceMode, useVoiceMode, voiceBarShown, voiceController } from './voiceMode'
import type { VoiceSnapshot } from './voiceSessionController'
import type { VoiceRunTarget } from './turnRouting'
import { STANDBY_HINT } from './stage/model'

/*
  The voice bar (docs/voice-mode.md §13.2): in place of the instruction
  line's box while voice mode is on. The record stays above it, so what the
  agent says aloud and what it did on screen are one glance apart. The voice
  view (D-48) covers the pane while it's open; this is what's left when it's
  closed. Keys and sounds belong to the session, not the bar
  (`VoiceSessionEffects`), so they work with no bar on screen.

  Row 1 (40px): orb · caption · time · where the audio goes.
  Row 2 (32px): Mute · Stop speaking · Stop the run · hint or problem · End.
*/

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Shown in the hint row until the first session ends (§13.5). */
export const FIRST_TIP = 'Talk naturally · interrupt any time · headphones work best'
const FIRST_TIP_KEY = 'vyotiq.voice.firstTipSeen'

export function firstTipSeen(): boolean {
  try {
    return localStorage.getItem(FIRST_TIP_KEY) === '1'
  } catch {
    return true
  }
}

export function markFirstTipSeen(): void {
  try {
    localStorage.setItem(FIRST_TIP_KEY, '1')
  } catch {
    /* blocked storage: the tip shows again next time, which is harmless */
  }
}

/** Esc twice within this window ends voice mode. */
export const DOUBLE_ESC_MS = 2000

export type ShownProblem = VoiceProblem & { detail: string }

export function withDetail(problem: VoiceProblem, detail: string, suffix = ''): ShownProblem {
  return { ...problem, message: `${problem.message}${suffix}`, detail }
}

/** Our sentence, then the provider's own reason, muted (D-40). The whole line is the tooltip when it's cut. */
export function ProblemText({ problem }: { problem: ShownProblem }) {
  const full = problem.detail ? `${problem.message} ${problem.detail}` : problem.message
  return (
    <span className="min-w-0 truncate" title={full} data-voice-problem-detail={problem.detail || undefined}>
      {problem.message}
      {problem.detail ? <span className="text-muted">{` ${problem.detail}`}</span> : null}
    </span>
  )
}

/**
 * What's wrong right now: `problem` ended the session; `trouble` is a note
 * the session survived (a lost turn first, it's the newest; then the voice).
 */
export function sessionNotes(v: VoiceSnapshot): { problem: ShownProblem | null; trouble: ShownProblem | null } {
  const problem = v.state === 'error' && v.error ? withDetail(voiceProblem(v.error), v.errorDetail) : null
  // The session goes on, so these are notes, not alarms: a lost turn first (it's the newest), then the voice.
  // No speaking provider at all is known from the start: say so then, not at the first reply.
  const trouble =
    v.state === 'error' || v.state === 'off'
      ? null
      : v.turnError
        ? withDetail(turnProblem(v.turnError.code), v.turnError.detail)
        : v.speakError
          ? withDetail(speakingProblem(v.speakError.code), v.speakError.detail, ' Replies are on screen.')
          : v.speaker === null
            ? withDetail(speakingProblem('no_key'), '', ' Replies are on screen.')
            : null
  return { problem, trouble }
}

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
  const { snapshot: v, settings, startedAt: sessionStartedAt, escArmed, viewOpen } = useVoiceMode()
  const controller = voiceController()
  // The session's clock, not this bar's: it keeps counting when the brief hands over to the task.
  const [mountedAt] = useState(() => Date.now())
  const [showFirstTip] = useState(() => !firstTipSeen())
  const startedAt = sessionStartedAt ?? mountedAt
  const [now, setNow] = useState(() => Date.now())
  // On screen: the view's pill isn't needed while this bar shows. Leaving the
  // screen while it owns the session (the line remounted), a newer line takes over.
  useEffect(() => registerVoiceBar(owner), [owner])

  // The task's send/stop change every render; keep the store pointed at them.
  setVoiceTarget(owner, target, workspacePath)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const listener = v.listener ? sttEntry(v.listener) : null
  const local = listener?.key.kind === 'none'
  const fellBackFrom = v.listenerFellBackFrom ? sttEntry(v.listenerFellBackFrom) : null
  const { problem, trouble: voiceTrouble } = sessionNotes(v)
  const speaker = v.speaker ? ttsEntry(v.speaker) : null
  const speakerFellBackFrom = v.speakerFellBackFrom ? ttsEntry(v.speakerFellBackFrom) : null
  // Never a silent fallback on either side (§9.5): the token says who listens and who speaks instead.
  const fallbackNote = [
    fellBackFrom && listener ? `Listening with ${listener.label}: no ${fellBackFrom.label} key.` : null,
    speakerFellBackFrom && speaker ? `Speaking with ${speaker.label}: no ${speakerFellBackFrom.label} key.` : null
  ]
    .filter(Boolean)
    .join(' ')
  // Stable: the orb restarts its frame loop whenever this changes, and the clock re-renders every second.
  const level = useMemo(() => () => controller.orbLevel(), [controller])

  // Caption: your words while you talk; the agent's while it speaks; else what's happening.
  // Captions off hides the words only; the agent still speaks (A-09).
  const words = settings.captions
  const caption =
    words && v.state === 'hearing' && v.partial ? (
      <span className="text-fg">{v.partial}</span>
    ) : words && v.state === 'speaking' && v.saying ? (
      <span className="text-muted">{v.saying}</span>
    ) : words && v.lastTurn && (v.state === 'thinking' || v.state === 'working') ? (
      <span className="text-muted">“{v.lastTurn}”</span>
    ) : (
      <span className="text-muted">
        {v.state === 'listening'
          ? v.standby
            ? STANDBY_HINT
            : idleCaption
          : v.state === 'reconnecting'
            ? `Reconnecting${v.reconnectAttempt > 1 ? ` (try ${v.reconnectAttempt})` : ''}…`
            : VOICE_STATE_LABEL[v.state]}
      </span>
    )

  // A placement is the control right now (§26): the bar keeps its line registered and draws nothing.
  if (!voiceBarShown({ viewOpen, settings })) return null

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
            title={fallbackNote ? `${fallbackNote} ${listener.privacy}` : listener.privacy}
            data-voice-engine={listener.id}
            data-voice-fell-back={fellBackFrom?.id}
            data-voice-speaker-fell-back={speakerFellBackFrom?.id}
          >
            {fallbackNote ? (
              <Icon name="warningCircle" size={12} className="text-warning" />
            ) : (
              <Icon name={local ? 'lock' : 'cloud'} size={12} />
            )}
            {listener.label}
            {fallbackNote ? <span className="sr-only">{`. ${fallbackNote}`}</span> : null}
          </span>
        ) : null}
      </div>

      <div className={cn('flex h-8 min-w-0 items-center gap-1 border-t pb-0.5 pl-2 pr-2', BORDER_DIVIDER)} data-voice-row="controls">
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
            Stop the task
          </Button>
        ) : null}

        {problem ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-danger" role="alert">
            <Icon name="warningCircle" size={13} className="shrink-0" />
            <ProblemText problem={problem} />
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
            <ProblemText problem={voiceTrouble} />
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

        {viewOpen ? null : (
          <Button size="xs" variant="ghost" icon="expand" onClick={() => setVoiceViewOpen(true)} data-voice-open-view>
            Voice view
          </Button>
        )}
        <Button size="xs" variant="secondary" icon="close" onClick={() => void endVoiceMode()} data-voice-end>
          End
        </Button>
      </div>
    </div>
  )
}
