import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { VoiceOptionInfo, VoiceSettings } from '@shared/ipc/schemas/voice'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts/match'
import { hasOpenFloatingLayer } from '@renderer/lib/hooks/floatingLayers'
import { useDictationState } from '@renderer/features/chat/components/composer/take/dictationStore'
import { playEarcon } from './earcons'
import { DOUBLE_ESC_MS, markFirstTipSeen } from './VoiceBar'
import { setSpeechOutput, speakText, stopSpeech, whenSpeechDone } from './speechPlayback'
import {
  dismissEndedVoice,
  endVoiceMode,
  patchVoiceSettings,
  setVoiceEscArmed,
  setVoiceViewOpen,
  startVoiceMode,
  stopVoiceTarget,
  switchVoiceMic,
  talkAgain,
  useVoiceMode,
  voiceController,
  type EndedVoiceConversation
} from './voiceMode'
import { IDLE_VOICE, type VoiceSnapshot } from './voiceSessionController'
import { requestVoiceConversations } from './history/voiceHistoryRequests'
import { DevicePickerContext, StageContext, VoicePickerContext, speakerFor, type DevicePickerDeps, type StageApi, type VoicePickerDeps } from './stage/kit'
import { Capsule, Companion, Inline, Summary, Takeover } from './stage/placements'
import { MiniWindowBridge } from './mini/miniBridge'

/*
  Voice mode on screen (docs/voice-mode.md §26, the 2026-10-15 redesign).
  Where it lives is a setting (Settings › Voice mode › Placement, or the
  Layout tab in the view itself):

    Inline     over the task pane: the voice thread, the composer as the voice control.
    Companion  a column docked right of the task.
    Takeover   the whole window under the title bar, sidebar included.
    Capsule    a pill at the bottom of the pane that grows into a card.
    Mini       its own always-on-top window (mini/), mirroring this one.

  It lives in the app shell, not in a composer, so it outlives the line that
  started it. "Show the task" closes it to the composer's voice bar, or the
  capsule's pill where no bar is on screen. End always leaves a summary.

  The shell mounts three slots: `VoiceView` in the main pane (Inline,
  Capsule, the summary, the mini window's bridge), `VoiceTakeoverLayer` over
  the navigator and the pane, and `VoiceCompanionColumn` beside the pane.
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
  const { settings: dictation } = useDictationState()

  // One mic for voice and dictation: a pick made anywhere (Settings › Dictation, the view's Devices tab) is the one it listens on.
  const listening = live && v.state !== 'connecting' && v.state !== 'error' && v.state !== 'off'
  useEffect(() => {
    if (!listening) return
    if ((controller.micDeviceId ?? '') !== (dictation.deviceId ?? '')) void controller.switchMic(dictation.deviceId)
  }, [listening, dictation.deviceId, controller])

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

/** An open menu, popover, modal dialog, or the view's own settings popover or history drawer: Escape closes that first. */
export function escapeBelongsToALayer(): boolean {
  return (
    hasOpenFloatingLayer() ||
    document.querySelector('[aria-expanded="true"][aria-haspopup], dialog[open], [aria-modal="true"], [data-voice-pop], [data-voice-drawer]') !== null
  )
}

// ── The session, as the placements read it ─────────────────────────────────

/** The placement showing in this window right now, or null. */
export type VoiceSurface = 'inline' | 'companion' | 'takeover' | 'capsule' | 'mini' | 'summary' | null

export function voiceSurface(m: { owner: string | null; ended: EndedVoiceConversation | null; viewOpen: boolean; bars: number; settings: Pick<VoiceSettings, 'placement'> }): VoiceSurface {
  if (m.owner === null) return m.ended ? 'summary' : null
  const p = m.settings.placement
  if (p === 'mini' || p === 'capsule') return p
  if (m.viewOpen) return p
  // "Show the task": the composer's voice bar stands in; with none on screen (Home, another task), the capsule's pill.
  return m.bars === 0 ? 'capsule' : null
}

function useMainStage(onOpenVoiceSettings?: () => void): StageApi {
  const { snapshot: v, settings, startedAt, escArmed, owner, workspacePath } = useVoiceMode()
  const controller = voiceController()
  // Stable: the orb, the meter and the ribbon restart their frame loops when these change.
  const level = useMemo(() => () => controller.orbLevel(), [controller])
  const micLevel = useMemo(() => () => controller.micLevel(), [controller])
  return useMemo<StageApi>(
    () => ({
      v,
      settings,
      startedAt,
      escArmed,
      level,
      micLevel,
      mute: (muted) => controller.setMuted(muted),
      hold: (down) => controller.ptt(down),
      stopSpeaking: () => controller.interrupt(),
      stopTask: () => void stopVoiceTarget(),
      end: () => void endVoiceMode(),
      retry: owner ? () => void startVoiceMode(owner, { workspacePath }) : undefined,
      showTask: () => setVoiceViewOpen(false),
      openView: () => setVoiceViewOpen(true),
      // Settings open in the app's pane: a placement over it (Takeover, Inline) steps aside so they are seen.
      openVoiceSettings: onOpenVoiceSettings
        ? () => {
            if (settings.placement === 'takeover' || settings.placement === 'inline') setVoiceViewOpen(false)
            onOpenVoiceSettings()
          }
        : undefined,
      openMicSettings: () => void window.vyotiq.dictationOpenMicSettings?.(),
      patchSettings: (patch) => {
        // A placement picked from the view shows at once.
        if (patch.placement) setVoiceViewOpen(true)
        void patchVoiceSettings(patch)
      },
      respondApproval: (requestId, decision, runId) => Promise.resolve(window.vyotiq.respondToolApproval?.(requestId, decision, runId)),
      respondQuestion: (requestId, questionId, value, runId) =>
        Promise.resolve(window.vyotiq.respondAgentQuestion?.(requestId, [{ questionId, values: [value] }], runId)),
      pickers: true
    }),
    [v, settings, startedAt, escArmed, level, micLevel, controller, owner, workspacePath, onOpenVoiceSettings]
  )
}

const SAMPLE_OWNER = 'voice-sample'
const SAMPLE_LINE = 'Hi, I’m ready when you are. Tell me what you want done.'

/** The voice and device pickers' reach into this window: voices over IPC, the mic in this renderer. */
function PickerProviders({ v, settings, children }: { v: VoiceSnapshot; settings: VoiceSettings; children: ReactNode }) {
  const controller = voiceController()
  const { settings: dictation } = useDictationState()
  const provider = speakerFor(v, settings, null)
  const voice = useMemo<VoicePickerDeps>(
    () => ({
      provider,
      listVoices: async (p, model) => {
        const res = await window.vyotiq.voiceListVoices?.({ provider: p, model })
        return res?.ok ? (res.data as VoiceOptionInfo[]) : null
      },
      playSample: async (p, voiceId, speed) => {
        // Where its voice will play.
        setSpeechOutput(settings.outputDeviceId)
        // The mic must not hear the sample, or it would answer it: held for the sample's length.
        controller.holdMic(true)
        try {
          await speakText(SAMPLE_OWNER, { text: SAMPLE_LINE, kind: 'plain', provider: p, voiceId, speed })
          await whenSpeechDone(SAMPLE_OWNER)
        } finally {
          controller.holdMic(false)
        }
      },
      stopSample: () => {
        stopSpeech()
        controller.holdMic(false)
      }
    }),
    [provider, controller, settings.outputDeviceId]
  )
  const devices = useMemo<DevicePickerDeps>(() => ({ micId: dictation.deviceId, switchMic: switchVoiceMic }), [dictation.deviceId])
  return (
    <VoicePickerContext.Provider value={voice}>
      <DevicePickerContext.Provider value={devices}>{children}</DevicePickerContext.Provider>
    </VoicePickerContext.Provider>
  )
}

function LiveStage({ onOpenVoiceSettings, children }: { onOpenVoiceSettings?: () => void; children: ReactNode }) {
  const api = useMainStage(onOpenVoiceSettings)
  return (
    <StageContext.Provider value={api}>
      <PickerProviders v={api.v} settings={api.settings}>
        {children}
      </PickerProviders>
    </StageContext.Provider>
  )
}

const noop = (): void => {}

/** The ended session as a still stage: the summary and its conversation read from it. */
function EndedStage({ ended, settings, children }: { ended: EndedVoiceConversation; settings: VoiceSettings; children: ReactNode }) {
  const api = useMemo<StageApi>(
    () => ({
      v: { ...IDLE_VOICE, transcript: ended.transcript, works: ended.works },
      settings,
      startedAt: ended.startedAt,
      escArmed: false,
      level: () => 0,
      micLevel: () => 0,
      mute: noop,
      hold: noop,
      stopSpeaking: noop,
      stopTask: noop,
      end: noop,
      patchSettings: (patch) => void patchVoiceSettings(patch),
      respondApproval: () => Promise.resolve(undefined),
      respondQuestion: () => Promise.resolve(undefined),
      pickers: false
    }),
    [ended, settings]
  )
  return <StageContext.Provider value={api}>{children}</StageContext.Provider>
}

/** The main pane's slot: Inline, the capsule, the summary, and the mini window's bridge. Mounted once. */
export function VoiceView({
  onOpenVoiceSettings,
  onOpenTask
}: {
  onOpenVoiceSettings?: () => void
  /** Open a task the session handed work to (the summary's rows). */
  onOpenTask?: (workspacePath: string, runId: string) => void
}) {
  const mode = useVoiceMode()
  const surface = voiceSurface(mode)
  return (
    <>
      <VoiceSessionEffects />
      {surface === 'summary' && mode.ended ? (
        <EndedStage ended={mode.ended} settings={mode.settings}>
          <Summary
            endedAt={mode.ended.endedAt}
            workspacePath={mode.ended.workspacePath}
            onClose={dismissEndedVoice}
            onOpenTask={
              onOpenTask
                ? (workspacePath, runId) => {
                    // Open task closes the summary (2026-10-15 decision); the conversation stays in All voice conversations.
                    dismissEndedVoice()
                    onOpenTask(workspacePath, runId)
                  }
                : undefined
            }
            onTalkAgain={talkAgain}
            onAllConversations={() => {
              if (mode.ended?.workspacePath && requestVoiceConversations(mode.ended.workspacePath)) dismissEndedVoice()
            }}
          />
        </EndedStage>
      ) : surface === 'inline' || surface === 'capsule' || surface === 'mini' ? (
        <LiveStage onOpenVoiceSettings={onOpenVoiceSettings}>
          {surface === 'inline' ? (
            <Inline />
          ) : surface === 'capsule' ? (
            <Capsule />
          ) : (
            // Without its window, the composer's bar is the control (it shows with the mini window); with no bar on screen, the capsule.
            <MiniWindowBridge fallback={mode.bars === 0 ? <Capsule /> : null} />
          )}
        </LiveStage>
      ) : null}
    </>
  )
}

/** Over the navigator and the main pane, under the title bar: Takeover. */
export function VoiceTakeoverLayer({ onOpenVoiceSettings }: { onOpenVoiceSettings?: () => void }) {
  const mode = useVoiceMode()
  if (voiceSurface(mode) !== 'takeover') return null
  return (
    <LiveStage onOpenVoiceSettings={onOpenVoiceSettings}>
      <Takeover />
    </LiveStage>
  )
}

/** Beside the main pane: Companion. */
export function VoiceCompanionColumn({ onOpenVoiceSettings }: { onOpenVoiceSettings?: () => void }) {
  const mode = useVoiceMode()
  if (voiceSurface(mode) !== 'companion') return null
  return (
    <LiveStage onOpenVoiceSettings={onOpenVoiceSettings}>
      <Companion />
    </LiveStage>
  )
}
