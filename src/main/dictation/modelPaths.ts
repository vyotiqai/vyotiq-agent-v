/**
 * Local Whisper ONNX cache under Electron userData (not the project tree).
 * Layout: {userData}/dictation/models/{modelId}/
 */
import { join } from 'path'
import { tmpdir } from 'os'
import type { DictationLocalModelId } from '../../shared/dictation'

let modelsRootOverride: string | null = null

/** Vitest: isolate model downloads. */
export function setDictationModelsRootOverrideForTests(root: string | null): void {
  modelsRootOverride = root
}

function resolveUserDataRoot(): string {
  try {
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.getPath === 'function') {
      return app.getPath('userData')
    }
  } catch {
    /* non-Electron */
  }
  return join(tmpdir(), 'vyotiq-userdata')
}

export function dictationModelsRoot(): string {
  if (modelsRootOverride) return modelsRootOverride
  return join(resolveUserDataRoot(), 'dictation', 'models')
}

export function dictationModelDir(modelId: DictationLocalModelId): string {
  const safe = modelId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'model'
  return join(dictationModelsRoot(), safe)
}
