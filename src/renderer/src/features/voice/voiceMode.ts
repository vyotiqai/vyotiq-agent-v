/**
 * Voice mode for the window (docs/voice-mode.md §13): at most one live
 * session, owned by one task's instruction line. The line that started it
 * renders the voice bar and keeps the store pointed at its task's send and
 * stop, so a finished turn goes to the task you're looking at.
 *
 * It can also start on the New task brief (§13.5, D-30): the first thing you
 * say becomes the task, and the session is handed to that task's line when
 * it appears, so the conversation carries on there.
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/ipc/schemas/voice'
import { getDictationState } from '@renderer/features/chat/components/composer/take/dictationStore'
import { routeVoiceTurn, type VoiceRunTarget } from './turnRouting'
import { stopSpeech } from './speechPlayback'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot, type VoiceTurn, type VoiceTurnResult } from './voiceSessionController'

type ModeState = {
  /** The instruction line that owns the session, or null. */
  owner: string | null
  settings: VoiceSettings
  /** When the session opened; survives the bar moving from the brief to the line. */
  startedAt: number | null
  /** The task's workspace the session opened with, for "Try again" from the view. */
  workspacePath: string | null
  /** The voice view covers the task pane (D-48); closed, the composer's bar (or a small pill) stands in. */
  viewOpen: boolean
  /** Esc was pressed once: a second press within two seconds ends voice mode. */
  escArmed: boolean
  /** Voice bars on screen (the owning line's composer); without one, the view's pill stands in. */
  bars: number
}

/** How long a brief's handoff waits for the new task's line to appear. */
export const HANDOFF_MS = 10_000

const IDLE_MODE: ModeState = { owner: null, settings: DEFAULT_VOICE_SETTINGS, startedAt: null, workspacePath: null, viewOpen: true, escArmed: false, bars: 0 }
let mode: ModeState = IDLE_MODE
/** The brief that just started a task by voice, waiting for its line. */
let handoff: { from: string; until: number } | null = null
const listeners = new Set<() => void>()
let target: VoiceRunTarget | null = null
let controller: VoiceSessionController | null = null
let offController: (() => void) | null = null
let watching = false
/** Line composers on screen, most recently focused last. */
const lines: string[] = []
/** When each line composer mounted: a line that just appeared can take over a session whose line went away. */
const lineBorn = new Map<string, number>()
/** Voice bars on screen per owning line. */
const ownerBars = new Map<string, number>()

function emit(next: Partial<ModeState>): void {
  mode = { ...mode, ...next }
  for (const l of listeners) l()
  // A session that ended, or moved to a line with a run, settles hand-offs waiting on one.
  settleRunIdWaiters()
}

/** Hand-offs waiting for the task's run id; resolved when a line reports one, not by polling. */
let runIdWaiters: Array<(id: string | null) => void> = []

function settleRunIdWaiters(): void {
  if (runIdWaiters.length === 0) return
  const id = mode.owner ? (target?.runId() ?? null) : null
  if (mode.owner && !id) return
  const waiting = runIdWaiters
  runIdWaiters = []
  for (const w of waiting) w(id)
}

function watchSettings(): void {
  if (watching || typeof window === 'undefined' || !window.vyotiq) return
  watching = true
  const api = window.vyotiq
  void api.getSettings?.().then((res) => {
    if (res?.ok && res.data.voice) emit({ settings: { ...DEFAULT_VOICE_SETTINGS, ...res.data.voice } })
  })
  api.onSettingsChanged?.((next) => {
    if (next.voice) emit({ settings: { ...DEFAULT_VOICE_SETTINGS, ...next.voice } })
  })
}

/**
 * Wait for the task's run id after sending its first message (it arrives with
 * the start). Reads whichever line owns the session now: a task started from
 * the brief gets its run id on the line it's handed to, which reports it
 * through `setVoiceTarget` as it renders.
 */
function waitForRunId(ms = HANDOFF_MS): Promise<string | null> {
  if (!mode.owner) return Promise.resolve(null)
  const now = target?.runId() ?? null
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const finish = (id: string | null): void => {
      clearTimeout(timer)
      runIdWaiters = runIdWaiters.filter((w) => w !== finish)
      resolve(id)
    }
    const timer = setTimeout(() => finish(null), ms)
    runIdWaiters.push(finish)
  })
}

/**
 * The voice's hand-off: to the owning line's task (or the brief, which starts
 * one). Resolves to the run to follow, or why the task never took it, so the
 * voice doesn't leave "On it." standing over nothing.
 */
export async function handleVoiceTurn(turn: VoiceTurn): Promise<VoiceTurnResult> {
  const t = target
  if (!t) return { failed: 'no_task' }
  const routed = await routeVoiceTurn(turn, t)
  if (routed.kind === 'stopped') return null
  if (routed.kind === 'dropped') return turn.stop ? null : { failed: 'refused' }
  return routed.runId ?? (await waitForRunId())
}

/** "Stop it": the voice asked to stop the agent's work on the owning line's task. */
export async function handleVoiceStop(): Promise<void> {
  const t = target
  if (t?.running()) await t.stop()
}

function ensureController(): VoiceSessionController {
  if (controller) return controller
  controller = new VoiceSessionController({ onTurn: handleVoiceTurn, onStopAgent: handleVoiceStop })
  offController = controller.subscribe(() => {
    // A session that ended on its own (window lost the mic, error then End) frees the line.
    if (controller?.snapshot.state === 'off' && mode.owner && !controller.active) emit({ owner: null })
    for (const l of listeners) l()
  })
  return controller
}

export async function startVoiceMode(owner: string, opts: { workspacePath?: string | null }): Promise<void> {
  watchSettings()
  const c = ensureController()
  if (mode.owner && mode.owner !== owner) await c.stop()
  handoff = null
  // A read-aloud still playing would talk over the conversation.
  stopSpeech()
  // A new session opens on the voice view (D-48).
  emit({ owner, startedAt: Date.now(), workspacePath: opts.workspacePath ?? null, viewOpen: true, escArmed: false })
  await c.start({
    workspacePath: opts.workspacePath ?? undefined,
    deviceId: getDictationState().settings.deviceId || undefined
  })
}

export async function endVoiceMode(): Promise<void> {
  const c = controller
  handoff = null
  emit({ owner: null, startedAt: null, workspacePath: null, escArmed: false })
  target = null
  await c?.stop()
}

/**
 * The brief is about to start a task with what you said: the next line to
 * appear takes the session over (unless the brief itself turns into it).
 */
export function beginVoiceHandoff(from: string): void {
  if (mode.owner === from) handoff = { from, until: Date.now() + HANDOFF_MS }
}

/** The task didn't start: the brief keeps the session. */
export function cancelVoiceHandoff(from: string): void {
  if (handoff?.from === from) handoff = null
}

/** Open or close the voice view over the task pane (D-48). */
export function setVoiceViewOpen(open: boolean): void {
  if (mode.viewOpen !== open) emit({ viewOpen: open })
}

export function setVoiceEscArmed(armed: boolean): void {
  if (mode.escArmed !== armed) emit({ escArmed: armed })
}

/**
 * A voice bar is on screen while mounted; returns the unregister. When the
 * owning line's last bar goes, the session moves on (`releaseVoiceLine`) —
 * checked after the commit, since StrictMode unmounts and remounts once.
 */
export function registerVoiceBar(owner: string): () => void {
  ownerBars.set(owner, (ownerBars.get(owner) ?? 0) + 1)
  emit({ bars: mode.bars + 1 })
  return () => {
    const left = (ownerBars.get(owner) ?? 1) - 1
    if (left > 0) ownerBars.set(owner, left)
    else ownerBars.delete(owner)
    emit({ bars: Math.max(0, mode.bars - 1) })
    if (left <= 0) {
      queueMicrotask(() => {
        if (!ownerBars.has(owner)) releaseVoiceLine(owner)
      })
    }
  }
}

/** Stop the agent's work on the owning line's task (the view's and bar's Stop the task). */
export async function stopVoiceTarget(): Promise<void> {
  await target?.stop()
}

/** Who owns the session right now (read outside React, e.g. in an unmount). */
export function voiceModeOwner(): string | null {
  return mode.owner
}

/** The owning line keeps this current every render: send, stop and run state change. */
export function setVoiceTarget(owner: string, t: VoiceRunTarget, workspacePath?: string | null): void {
  if (mode.owner !== owner) return
  target = t
  // The task this line is on, finished or not: the voice reads its conversation (after this render).
  if (controller) {
    const c = controller
    const taskRun = t.brief ? null : t.runId()
    queueMicrotask(() => {
      if (mode.owner === owner && target === t) c.setTask(taskRun, workspacePath ?? undefined)
    })
  }
  // The brief became the task's line in place: nothing to hand over.
  if (handoff?.from === owner && !t.brief) handoff = null
  settleRunIdWaiters()
  // A run already working on this task (voice opened on it, or moved to it) is followed too.
  // After this render: following updates the store, which mustn't happen mid-render.
  const runId = t.running() ? t.runId() : null
  if (runId && controller) {
    const c = controller
    queueMicrotask(() => {
      if (mode.owner === owner && target === t) c.followRun(runId)
    })
  }
}

export function voiceController(): VoiceSessionController {
  return ensureController()
}

// ── Which line a shortcut goes to ───────────────────────────────────────────

export function registerVoiceLine(key: string): () => void {
  if (!lines.includes(key)) lines.push(key)
  lineBorn.set(key, Date.now())
  if (handoff && key !== handoff.from && mode.owner === handoff.from) {
    const fresh = Date.now() <= handoff.until
    handoff = null
    if (fresh) emit({ owner: key })
  }
  return () => {
    const i = lines.indexOf(key)
    if (i >= 0) lines.splice(i, 1)
    lineBorn.delete(key)
  }
}

/**
 * The owning line's voice bar left the screen while the session is live. The
 * task's line remounts when the task starts and when its pane re-lays out, and
 * each mount is a new owner id: without this the session stays tied to a dead
 * line, the hand-off never learns the run id, and the agent's reply is never
 * spoken. A line that appeared in the last few seconds takes the session now;
 * otherwise the next one to appear does.
 */
export function releaseVoiceLine(owner: string): void {
  if (mode.owner !== owner || !controller?.active) return
  const now = Date.now()
  const heir = lines.filter((k) => k !== owner && now - (lineBorn.get(k) ?? 0) <= HANDOFF_MS).at(-1)
  if (heir) {
    handoff = null
    emit({ owner: heir })
    return
  }
  // A brief's pending hand-off already waits for the task's line.
  if (handoff?.from !== owner) handoff = { from: owner, until: now + HANDOFF_MS }
}

export function noteVoiceLineFocus(key: string): void {
  const i = lines.indexOf(key)
  if (i >= 0) lines.splice(i, 1)
  lines.push(key)
}

/** The line Ctrl+Shift+M should act on: the session's owner, else the last focused line. */
export function voiceShortcutTarget(): string | null {
  return mode.owner ?? lines.at(-1) ?? null
}

// ── React ───────────────────────────────────────────────────────────────────

function subscribe(fn: () => void): () => void {
  watchSettings()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

type ModeView = Omit<ModeState, never> & { snapshot: VoiceSnapshot }
let view: ModeView = { ...IDLE_MODE, snapshot: IDLE_VOICE }

function read(): ModeView {
  const snapshot = controller?.snapshot ?? IDLE_VOICE
  if (
    view.owner !== mode.owner ||
    view.snapshot !== snapshot ||
    view.settings !== mode.settings ||
    view.startedAt !== mode.startedAt ||
    view.workspacePath !== mode.workspacePath ||
    view.viewOpen !== mode.viewOpen ||
    view.escArmed !== mode.escArmed ||
    view.bars !== mode.bars
  ) {
    view = { ...mode, snapshot }
  }
  return view
}

export function useVoiceMode(): ModeView {
  return useSyncExternalStore(subscribe, read, read)
}

/** Tests only. */
export async function resetVoiceModeForTests(c?: VoiceSessionController): Promise<void> {
  offController?.()
  offController = null
  await controller?.stop()
  controller = c ?? null
  if (controller) {
    offController = controller.subscribe(() => {
      for (const l of listeners) l()
    })
  }
  target = null
  handoff = null
  for (const w of runIdWaiters.splice(0)) w(null)
  lines.length = 0
  lineBorn.clear()
  ownerBars.clear()
  // Settings are read again from the next test's bridge.
  watching = false
  mode = IDLE_MODE
}
