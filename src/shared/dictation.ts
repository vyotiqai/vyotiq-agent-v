/**
 * Curated local dictation catalog. Both backends run ONNX weights in the
 * dictation worker via @huggingface/transformers:
 *  - `whisper`: pads every call to 30 s of audio, so a call costs the same
 *    whatever was said — Small takes seconds on a laptop CPU.
 *  - `moonshine`: costs in proportion to the audio, so a phrase takes a
 *    fraction of a second. It invents words for audio cut mid-word, which
 *    finished phrases (cut at pauses) never are — so it writes final words
 *    and Whisper Tiny still drafts the live ones.
 */

export const DICTATION_LOCAL_MODEL_IDS = ['whisper-tiny.en', 'whisper-small.en', 'moonshine-base'] as const
export type DictationLocalModelId = (typeof DICTATION_LOCAL_MODEL_IDS)[number]

export type DictationLocalBackend = 'whisper' | 'moonshine'

export type DictationLocalCatalogEntry = {
  id: DictationLocalModelId
  backend: DictationLocalBackend
  hubRepo: string
  label: string
  language: string
  /** `fast` drafts live words for the others when it is installed. */
  role: 'fast' | 'quality' | 'instant'
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
  },
  {
    id: 'moonshine-base',
    backend: 'moonshine',
    hubRepo: 'onnx-community/moonshine-base-ONNX',
    label: 'Moonshine Base',
    language: 'English',
    role: 'instant',
    roleLabel: 'Fastest',
    approxDownloadLabel: '~123 MB',
    ramHint: 'Words land moments after each pause · a little less accurate than Whisper Small'
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
