import { useEffect, useMemo, useRef, useState } from 'react'
import { VOICE_STATE_LABEL, type VoiceSessionState } from '@shared/voiceSession'
import { IconButton } from '@renderer/lib/ui'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts/match'
import { hasOpenFloatingLayer } from '@renderer/lib/hooks/floatingLayers'
import { playEarcon } from './earcons'
import { VoiceOrb } from './VoiceOrb'
import { DOUBLE_ESC_MS, firstTipSeen, markFirstTipSeen } from './VoiceBar'
import { endVoiceMode, setVoiceEscArmed, setVoiceViewOpen, useVoiceMode, voiceController } from './voiceMode'
import { ConversationLayout, OrbLayout, SplitLayout, type LayoutProps } from './view/layouts'

/*
  The voice view (docs/voice-mode.md §25, D-48): a spoken conversation over
  the task pane. An orb that moves with your voice and its voice, what's
  happening in a word, the conversation so far with each hand-off's live
  steps and result, and Mute and End at the bottom. Its layout and the orb's
  look are settings (Settings › Voice mode; view/layouts.tsx). The task's
  record is one click away ("Show the task").

  It lives in the app shell, not in a composer, so it outlives the line that
  started it: switch tasks or go Home and the conversation stays on screen.
*/

/**
 * What belongs to the session rather than to any one surface (§13.6): its
 * keys and its sounds. Mounted once, with the view, so they work wherever
 * you are while voice mode is on.
 */
export function VoiceSessionEffects() {
  const { owner, snapshot: v, settings } = useVoiceMode()
  const controller = voiceController()
  const live = owner !== null

  // A sound when the session opens and when it ends.
  const wasLive = useRef(false)
  useEffect(() => {
    if (live && !wasLive.current) playEarcon('start', settings.earcons)
    if (!live && wasLive.current) {
      playEarcon('end', settings.earcons)
      markFirstTipSeen()
    }
    wasLive.current = live
  }, [live, settings.earcons])

  // A soft sound for a slow step, when spoken progress is off.
  const lastCues = useRef(v.cues)
  useEffect(() => {
    if (v.cues > lastCues.current) playEarcon('work', settings.earcons)
    lastCues.current = v.cues
  }, [v.cues, settings.earcons])

  // A tick when a turn is accepted.
  const lastTurn = useRef('')
  useEffect(() => {
    if (v.lastTurn && v.lastTurn !== lastTurn.current) {
      lastTurn.current = v.lastTurn
      playEarcon('turn', settings.earcons)
    }
  }, [v.lastTurn, settings.earcons])

  // Keys while voice mode is on. Capture phase, so Esc here never also stops the run.
  useEffect(() => {
    if (!live) return
    let lastEsc = 0
    let pttHeld = false
    let disarm: ReturnType<typeof setTimeout> | null = null
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // A menu, popover or dialog closes on this Escape, not voice mode.
        if (escapeBelongsToALayer()) return
        e.preventDefault()
        e.stopPropagation()
        if (controller.snapshot.state === 'speaking') {
          controller.interrupt()
          return
        }
        const t = Date.now()
        if (t - lastEsc < DOUBLE_ESC_MS) {
          void endVoiceMode()
          return
        }
        lastEsc = t
        setVoiceEscArmed(true)
        if (disarm) clearTimeout(disarm)
        disarm = setTimeout(() => setVoiceEscArmed(false), DOUBLE_ESC_MS)
        return
      }
      // Bare letters and Space belong to any text field, empty or not.
      if (isEditableShortcutTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        controller.setMuted(!controller.snapshot.muted)
        return
      }
      // Space presses a focused button, ticks a box, opens a select: theirs, not push-to-talk.
      if (e.code === 'Space' && !e.repeat && !pttHeld && !spaceActivates(e.target)) {
        e.preventDefault()
        pttHeld = true
        controller.ptt(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && pttHeld) {
        e.preventDefault()
        pttHeld = false
        controller.ptt(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      if (disarm) clearTimeout(disarm)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [live, controller])

  return null
}

/** Controls Space activates (WCAG 2.1.1): pressing it there must never be taken for push-to-talk. */
const SPACE_CONTROLS =
  'button, a[href], select, summary, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]'

export function spaceActivates(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SPACE_CONTROLS) !== null
}

/** An open menu, popover or modal dialog: Escape closes that first. */
export function escapeBelongsToALayer(): boolean {
  return (
    hasOpenFloatingLayer() ||
    document.querySelector('[aria-expanded="true"][aria-haspopup], dialog[open], [aria-modal="true"]') !== null
  )
}

function FullView({ onOpenVoiceSettings }: { onOpenVoiceSettings?: () => void }) {
  const { snapshot: v, settings, startedAt, escArmed, owner, workspacePath } = useVoiceMode()
  const controller = voiceController()
  const [firstTip] = useState(() => !firstTipSeen())
  const level = useMemo(() => () => controller.orbLevel(), [controller])
  const props: LayoutProps = { v, settings, startedAt, escArmed, firstTip, owner, workspacePath, level, onOpenVoiceSettings }
  return (
    <>
      {/* State changes are announced; the words are not (they change too fast to be useful read out). */}
      <span className="sr-only" role="status" aria-live="polite">
        {VOICE_STATE_LABEL[v.state]}
      </span>
      {settings.viewLayout === 'orb' ? (
        <OrbLayout {...props} />
      ) : settings.viewLayout === 'split' ? (
        <SplitLayout {...props} />
      ) : (
        <ConversationLayout {...props} />
      )}
    </>
  )
}

/** What's happening, in a word or two, in the pill. */
const PILL_HEADLINE: Readonly<Record<VoiceSessionState, string>> = { ...VOICE_STATE_LABEL, hearing: 'Listening', working: 'Working on it', waiting_on_you: 'Needs you' }

/** With the view closed and no voice bar on screen (Home, another task): a small pill keeps it in reach. */
function MiniPill() {
  const { snapshot: v } = useVoiceMode()
  const controller = voiceController()
  const level = (): number => controller.orbLevel()
  return (
    <div
      className="vy-menu absolute bottom-4 right-4 z-sticky flex h-10 items-center gap-2 pl-3 pr-2"
      role="group"
      aria-label="Voice mode"
      data-voice-pill={v.state}
    >
      <VoiceOrb state={v.state} level={level} size={20} />
      <span className="text-sm text-fg">{PILL_HEADLINE[v.state]}</span>
      <IconButton icon="expand" label="Open the voice view" size="sm" onClick={() => setVoiceViewOpen(true)} />
      <IconButton icon="close" label="End voice mode" size="sm" onClick={() => void endVoiceMode()} />
    </div>
  )
}

/** Mounted once in the app shell, over the main pane. */
export function VoiceView({ onOpenVoiceSettings }: { onOpenVoiceSettings?: () => void }) {
  const { owner, viewOpen, bars } = useVoiceMode()
  return (
    <>
      <VoiceSessionEffects />
      {owner === null ? null : viewOpen ? (
        <FullView onOpenVoiceSettings={onOpenVoiceSettings} />
      ) : bars === 0 ? (
        <MiniPill />
      ) : null}
    </>
  )
}
