/**
 * Voice mode for the window (docs/voice-mode.md §13): at most one live
 * session, owned by one task's instruction line. The line that started it
 * renders the voice bar and keeps the store pointed at its task's send and
 * stop, so a finished turn goes to the task you're looking at.
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/ipc/schemas/voice'
import { getDictationState } from '@renderer/features/chat/components/composer/take/dictationStore'
import { routeVoiceTurn, type VoiceRunTarget } from './turnRouting'
import { IDLE_VOICE, VoiceSessionController, type VoiceSnapshot } from './voiceSessionController'

type ModeState = {
  /** The instruction line that owns the session, or null. */
  owner: string | null
  settings: VoiceSettings
}

let mode: ModeState = { owner: null, settings: DEFAULT_VOICE_SETTINGS }
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

/** Wait for the task's run id after sending its first message (it arrives with the start). */
async function waitForRunId(t: VoiceRunTarget, ms = 3000): Promise<string | null> {
  for (let waited = 0; waited <= ms; waited += 50) {
    const id = t.runId()
    if (id) return id
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

function ensureController(): VoiceSessionController {
  if (controller) return controller
  controller = new VoiceSessionController({
    onTurn: async (turn) => {
      const t = target
      if (!t) return null
      const routed = await routeVoiceTurn(turn, t, mode.settings.interruptMode)
      if (routed.kind !== 'sent') return null
      return routed.runId ?? (await waitForRunId(t))
    }
  })
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
  emit({ owner })
  await c.start({
    workspacePath: opts.workspacePath ?? undefined,
    deviceId: getDictationState().settings.deviceId || undefined
  })
}

export async function endVoiceMode(): Promise<void> {
  const c = controller
  emit({ owner: null })
  target = null
  await c?.stop()
}

/** The owning line keeps this current every render: send, stop and run state change. */
export function setVoiceTarget(owner: string, t: VoiceRunTarget): void {
  if (mode.owner === owner) target = t
}

export function voiceController(): VoiceSessionController {
  return ensureController()
}

// ── Which line a shortcut goes to ───────────────────────────────────────────

export function registerVoiceLine(key: string): () => void {
  if (!lines.includes(key)) lines.push(key)
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

type ModeView = { owner: string | null; snapshot: VoiceSnapshot; settings: VoiceSettings }
let view: ModeView = { owner: null, snapshot: IDLE_VOICE, settings: DEFAULT_VOICE_SETTINGS }

function read(): ModeView {
  const snapshot = controller?.snapshot ?? IDLE_VOICE
  if (view.owner !== mode.owner || view.snapshot !== snapshot || view.settings !== mode.settings) {
    view = { owner: mode.owner, snapshot, settings: mode.settings }
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
  lines.length = 0
  mode = { owner: null, settings: DEFAULT_VOICE_SETTINGS }
}
