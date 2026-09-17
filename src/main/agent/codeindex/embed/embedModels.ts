/**
 * Embedding model identity + local cache for the code-index dense (concept)
 * search leg. Global (non-workspace) cache under Electron userData, mirroring
 * the dictation model cache layout ({userData}/embed/models/{modelId}/).
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { downloadMissingFiles, hfResolve, type DownloadFileSpec } from './download'

export const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
export const EMBED_DIM = 384

let modelsRootOverride: string | null = null

/** Vitest: isolate model downloads. */
export function setEmbedModelsRootOverrideForTests(root: string | null): void {
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

export function embedModelsRoot(): string {
  if (modelsRootOverride) return modelsRootOverride
  return join(resolveUserDataRoot(), 'embed', 'models')
}

export function embedModelDir(): string {
  const safe = EMBED_MODEL_ID.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'model'
  return join(embedModelsRoot(), safe)
}

/**
 * transformers.js v4 artifacts for MiniLM-L6-v2. The loader resolves ONNX
 * weights under the repo's `onnx/` subfolder (default subfolder='onnx'), so the
 * q8 weight file must land at onnx/model_quantized.onnx — not flat at the root.
 */
export function embedModelFiles(): DownloadFileSpec[] {
  return [
    'config.json',
    'onnx/model_quantized.onnx',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json'
  ].map((relativePath) => ({ relativePath, url: hfResolve(EMBED_MODEL_ID, relativePath) }))
}

export function embedModelFilesPresent(dir: string = embedModelDir()): boolean {
  return embedModelFiles().every((spec) => existsSync(join(dir, spec.relativePath)))
}

/**
 * Download any missing q8 artifacts. `onProgress` fires at most once per file,
 * so callers can throttle their own status updates.
 */
export async function ensureEmbedModelFiles(
  dir: string = embedModelDir(),
  opts?: {
    signal?: AbortSignal
    onProgress?: (p: { file: string; completed: number; total: number }) => void
  }
): Promise<void> {
  await downloadMissingFiles(dir, embedModelFiles(), opts)
}