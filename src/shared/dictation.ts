/**
 * Curated local dictation catalog. One backend:
 *  - `whisper`: ONNX weights run in-process via @huggingface/transformers.
 */

export const DICTATION_LOCAL_MODEL_IDS = ['whisper-tiny.en', 'whisper-small.en'] as const
export type DictationLocalModelId = (typeof DICTATION_LOCAL_MODEL_IDS)[number]

export type DictationLocalBackend = 'whisper'

export type DictationLocalCatalogEntry = {
  id: DictationLocalModelId
  backend: DictationLocalBackend
  hubRepo: string
  label: string
  language: string
  role: 'fast' | 'quality'
  roleLabel: string
  approxDownloadLabel: string
  ramHint: string
}

export const DICTATION_LOCAL_CATALOG: readonly DictationLocalCatalogEntry[] = [
  {
    id: 'whisper-tiny.en',
    backend: 'whisper',
    hubRepo: 'onnx-community/whisper-tiny.en',
    label: 'Whisper Tiny',
    language: 'English',
    role: 'fast',
    roleLabel: 'Fast',
    approxDownloadLabel: '~41 MB',
    ramHint: 'Lower RAM — prefer this under 8 GB'
  },
  {
    id: 'whisper-small.en',
    backend: 'whisper',
    hubRepo: 'onnx-community/whisper-small.en',
    label: 'Whisper Small',
    language: 'English',
    role: 'quality',
    roleLabel: 'Recommended',
    approxDownloadLabel: '~249 MB',
    ramHint: 'Better accuracy when you have 8 GB+ RAM'
  }
]

export function dictationCatalogEntry(
  id: DictationLocalModelId
): DictationLocalCatalogEntry {
  const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === id)
  if (!entry) throw new Error(`Unknown dictation model: ${id}`)
  return entry
}

/** RAM threshold for the Voice card hardware hint (not auto-install). */
export const DICTATION_SMALL_MODEL_MIN_BYTES = 8 * 1024 * 1024 * 1024
