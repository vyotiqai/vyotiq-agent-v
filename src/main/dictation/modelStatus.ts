import type {
  DictationEngine,
  DictationLocalModelId,
  DictationRuntimeStatus
} from '../../shared/ipc'

const listeners = new Set<(s: DictationRuntimeStatus) => void>()

let phase: DictationRuntimeStatus['phase'] = 'idle'
let progress: number | null = null
let message: string | null = null
let error: string | null = null
let activeModelId: DictationLocalModelId | null = null
let loadedModelId: DictationLocalModelId | null = null
let installed: DictationRuntimeStatus['installed'] = []
let recommendedModelId: DictationLocalModelId = 'whisper-small.en'
let engine: DictationEngine = 'openai'

function snapshot(): DictationRuntimeStatus {
  return {
    phase,
    progress,
    message,
    error,
    installed: installed.map((m) => ({ ...m })),
    recommendedModelId,
    engine,
    activeModelId,
    loadedModelId
  }
}

function emit(): void {
  const snap = snapshot()
  for (const fn of listeners) {
    try {
      fn(snap)
    } catch {
      /* ignore listener errors */
    }
  }
}

export function getDictationRuntimeStatus(): DictationRuntimeStatus {
  return snapshot()
}

export function setDictationRuntimeStatus(
  partial: Partial<
    Pick<
      DictationRuntimeStatus,
      | 'phase'
      | 'progress'
      | 'message'
      | 'error'
      | 'installed'
      | 'recommendedModelId'
      | 'engine'
      | 'activeModelId'
      | 'loadedModelId'
    >
  >
): void {
  if (partial.phase !== undefined) phase = partial.phase
  if (partial.progress !== undefined) progress = partial.progress
  if (partial.message !== undefined) message = partial.message
  if (partial.error !== undefined) error = partial.error
  if (partial.installed !== undefined) installed = partial.installed
  if (partial.recommendedModelId !== undefined) recommendedModelId = partial.recommendedModelId
  if (partial.engine !== undefined) engine = partial.engine
  if (partial.activeModelId !== undefined) activeModelId = partial.activeModelId
  if (partial.loadedModelId !== undefined) loadedModelId = partial.loadedModelId
  emit()
}

export function onDictationRuntimeStatus(
  fn: (s: DictationRuntimeStatus) => void
): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function resetDictationRuntimeStatusForTests(): void {
  phase = 'idle'
  progress = null
  message = null
  error = null
  activeModelId = null
  loadedModelId = null
  installed = []
  recommendedModelId = 'whisper-small.en'
  engine = 'openai'
  listeners.clear()
}
