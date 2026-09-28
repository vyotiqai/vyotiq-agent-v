import { useSyncExternalStore } from 'react'
import {
  DEFAULT_DICTATION_SETTINGS,
  type DictationEngine,
  type DictationRuntimeStatus,
  type DictationSettings,
  type SecretProvider
} from '@shared/ipc'
import { DICTATION_LOCAL_CATALOG } from '@shared/dictation'

/*
  Dictation settings and the local model's state, read once and kept fresh
  for every mic in the window. The old hook read settings and model status
  over IPC on each press, before opening the mic — the first words were lost
  to that wait. Readiness is known before the press now.
*/

type DictationState = {
  settings: DictationSettings
  runtime: DictationRuntimeStatus | null
  loaded: boolean
}

let state: DictationState = { settings: DEFAULT_DICTATION_SETTINGS, runtime: null, loaded: false }
const listeners = new Set<() => void>()
let started = false
let unsubscribers: Array<() => void> = []

function emit(next: Partial<DictationState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function startWatching(): void {
  if (started || typeof window === 'undefined' || !window.vyotiq) return
  started = true
  const api = window.vyotiq
  void Promise.all([
    typeof api.getSettings === 'function' ? api.getSettings() : null,
    typeof api.dictationStatus === 'function' ? api.dictationStatus() : null
  ])
    .then(([s, r]) => {
      emit({
        loaded: true,
        ...(s?.ok && s.data.dictation ? { settings: { ...DEFAULT_DICTATION_SETTINGS, ...s.data.dictation } } : {}),
        ...(r?.ok ? { runtime: r.data } : {})
      })
    })
    .catch(() => emit({ loaded: true }))
  const offSettings = api.onSettingsChanged?.((next) => {
    if (next.dictation) emit({ settings: { ...DEFAULT_DICTATION_SETTINGS, ...next.dictation } })
  })
  const offStatus = api.onDictationStatus?.((runtime) => emit({ runtime }))
  unsubscribers = [offSettings, offStatus].filter((f): f is () => void => typeof f === 'function')
}

function subscribe(listener: () => void): () => void {
  startWatching()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDictationState(): DictationState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

export function getDictationState(): DictationState {
  startWatching()
  return state
}

/** Write through to settings; the store updates from main's echo. */
export async function patchDictationSettings(patch: Partial<DictationSettings>): Promise<boolean> {
  const next = { ...state.settings, ...patch }
  emit({ settings: next })
  const res = await window.vyotiq.setSettings({ dictation: next })
  if (res.ok) emit({ settings: { ...DEFAULT_DICTATION_SETTINGS, ...res.data.dictation } })
  return res.ok
}

export function noteRuntimeStatus(runtime: DictationRuntimeStatus): void {
  emit({ runtime })
}

/** Tests: forget everything. */
export function resetDictationStoreForTests(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
  started = false
  listeners.clear()
  state = { settings: DEFAULT_DICTATION_SETTINGS, runtime: null, loaded: false }
}

export const ENGINE_LABEL: Record<DictationEngine, string> = {
  local: 'This PC',
  openai: 'OpenAI',
  openrouter: 'OpenRouter'
}

/** Can this engine transcribe right now? */
export function engineReady(
  engine: DictationEngine,
  secrets: Record<SecretProvider, boolean>,
  runtime: DictationRuntimeStatus | null
): boolean {
  switch (engine) {
    case 'openai':
      return Boolean(secrets.openai)
    case 'openrouter':
      return Boolean(secrets.openrouter)
    case 'local':
      // Unknown before the first status arrives: let the press try.
      return runtime == null || runtime.installed.length > 0
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}

/** Another engine a failed take could go to, preferring the one that stays on this PC. */
export function fallbackEngine(
  failed: DictationEngine,
  secrets: Record<SecretProvider, boolean>,
  runtime: DictationRuntimeStatus | null
): DictationEngine | null {
  const order: DictationEngine[] = ['local', 'openai', 'openrouter']
  for (const e of order) {
    if (e === failed) continue
    if (e === 'local' ? (runtime?.installed.length ?? 0) > 0 : engineReady(e, secrets, runtime)) return e
  }
  return null
}

/**
 * Whether live words can be drafted on this PC while you speak. Drafts hear
 * speech cut mid-word; Whisper copes, Moonshine makes words up. So they need
 * a Whisper model to draft with — Tiny next to any chosen model, or a chosen
 * Whisper model itself. Moonshine alone writes each phrase when you pause.
 */
export function localLiveDrafts(settings: DictationSettings, runtime: DictationRuntimeStatus | null): boolean {
  const installed = runtime?.installed.map((m) => m.id) ?? []
  const whisper = (id: string | undefined): boolean =>
    DICTATION_LOCAL_CATALOG.find((m) => m.id === id)?.backend === 'whisper'
  if (DICTATION_LOCAL_CATALOG.some((m) => m.role === 'fast' && m.backend === 'whisper' && installed.includes(m.id))) return true
  const chosen =
    settings.localModelId && installed.includes(settings.localModelId)
      ? settings.localModelId
      : runtime?.recommendedModelId && installed.includes(runtime.recommendedModelId)
        ? runtime.recommendedModelId
        : installed[0]
  return whisper(chosen)
}

/** The label the mic's tooltip gives the engine: "This PC · Whisper Small". */
export function engineDetail(settings: DictationSettings, runtime: DictationRuntimeStatus | null): string {
  if (settings.engine !== 'local') return ENGINE_LABEL[settings.engine]
  const id = settings.localModelId || runtime?.loadedModelId || runtime?.installed[0]?.id
  const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === id)
  return entry ? `This PC · ${entry.label}` : 'This PC'
}
