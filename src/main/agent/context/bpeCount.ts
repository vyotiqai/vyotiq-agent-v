/**
 * The one BPE count, shared by the main-thread tokenizer and the worker entry.
 *
 * Imported by `tokenizer.worker.ts`, which is its own bundle entry: keep this
 * module free of Electron and agent imports — gpt-tokenizer only.
 */
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base'
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base'

export type EncodingName = 'o200k_base' | 'cl100k_base'

export const HEURISTIC_CHARS_PER_TOKEN = 4

/** BPE token count; a malformed lone surrogate can throw, and chars/4 beats crashing. */
export function countBpeTokens(text: string, encoding: EncodingName): number {
  try {
    return encoding === 'cl100k_base' ? encodeCl100k(text).length : encodeO200k(text).length
  } catch {
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN)
  }
}
