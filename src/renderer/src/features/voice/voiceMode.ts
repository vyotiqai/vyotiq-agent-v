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
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot, type VoiceTurn } from './voiceSessionController'

type ModeState = {
  /** The instruction line that owns the session, or null. */
  owner: string | null
  settings: VoiceSettings
  /** When the session opened; survives the bar moving from the brief to the line. */
  startedAt: number | null
}

/** How long a brief's handoff waits for the new task's line to appear. */
export const HANDOFF_MS = 10_000

let mode: ModeState = { owner: null, settings: DEFAULT_VOICE_SETTINGS, startedAt: null }
/** The brief that just started a task by voice, waiting for its line. */
let handoff: { from: string; until: number } | null = null
const listeners = new Set<() => void>()
let target: VoiceRunTarget | null = null
let controller: VoiceSessionController | null = null
let offController: (() => void) | null = null
let watching = false
/** Line composers on screen, most recently focused last. */
const lines: string[] = []

function emit(next: Partial<ModeState>): void {
  mode = { ...mode, ...next }
  for (const l of listeners) l()
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
 * the brief gets its run id on the line it's handed to.
 */
async function waitForRunId(ms = HANDOFF_MS): Promise<string | null> {
  for (let waited = 0; waited <= ms; waited += 50) {
    if (!mode.owner) return null
    const id = target?.runId() ?? null
    if (id) return id
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

/** A finished turn: to the owning line's task (or the brief, which starts one); resolves to the run to follow. */
export async function handleVoiceTurn(turn: VoiceTurn): Promise<string | null> {
  const t = target
  if (!t) return null
  const routed = await routeVoiceTurn(turn, t, mode.settings.interruptMode)
  if (routed.kind !== 'sent') return null
  return routed.runId ?? (await waitForRunId())
}

function ensureController(): VoiceSessionController {
  if (controller) return controller
  controller = new VoiceSessionController({ onTurn: handleVoiceTurn })
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
  emit({ owner, startedAt: Date.now() })
  await c.start({
    workspacePath: opts.workspacePath ?? undefined,
    deviceId: getDictationState().settings.deviceId || undefined
  })
}

export async function endVoiceMode(): Promise<void> {
  const c = controller
  handoff = null
  emit({ owner: null, startedAt: null })
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

/** Who owns the session right now (read outside React, e.g. in an unmount). */
export function voiceModeOwner(): string | null {
  return mode.owner
}

/** The owning line keeps this current every render: send, stop and run state change. */
export function setVoiceTarget(owner: string, t: VoiceRunTarget): void {
  if (mode.owner !== owner) return
  target = t
  // The brief became the task's line in place: nothing to hand over.
  if (handoff?.from === owner && !t.brief) handoff = null
}

export function voiceController(): VoiceSessionController {
  return ensureController()
}

// ── Which line a shortcut goes to ───────────────────────────────────────────

export function registerVoiceLine(key: string): () => void {
  if (!lines.includes(key)) lines.push(key)
  if (handoff && key !== handoff.from && mode.owner === handoff.from) {
    const fresh = Date.now() <= handoff.until
    handoff = null
    if (fresh) emit({ owner: key })
  }
  return () => {
    const i = lines.indexOf(key)
    if (i >= 0) lines.splice(i, 1)
  }
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

type ModeView = { owner: string | null; snapshot: VoiceSnapshot; settings: VoiceSettings; startedAt: number | null }
let view: ModeView = { owner: null, snapshot: IDLE_VOICE, settings: DEFAULT_VOICE_SETTINGS, startedAt: null }

function read(): ModeView {
  const snapshot = controller?.snapshot ?? IDLE_VOICE
  if (
    view.owner !== mode.owner ||
    view.snapshot !== snapshot ||
    view.settings !== mode.settings ||
    view.startedAt !== mode.startedAt
  ) {
    view = { owner: mode.owner, snapshot, settings: mode.settings, startedAt: mode.startedAt }
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
  lines.length = 0
  mode = { owner: null, settings: DEFAULT_VOICE_SETTINGS, startedAt: null }
}
