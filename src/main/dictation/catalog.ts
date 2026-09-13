import { totalmem } from 'os'
import {
  DICTATION_LOCAL_CATALOG,
  DICTATION_SMALL_MODEL_MIN_BYTES,
  type DictationLocalModelId
} from '../../shared/dictation'

export {
  DICTATION_LOCAL_CATALOG,
  DICTATION_LOCAL_MODEL_IDS,
  dictationCatalogEntry,
  type DictationLocalCatalogEntry,
  type DictationLocalModelId
} from '../../shared/dictation'

/** Hardware hint only — never auto-install. */
export function recommendedDictationModelId(
  totalBytes: number = totalmem()
): DictationLocalModelId {
  return totalBytes < DICTATION_SMALL_MODEL_MIN_BYTES ? 'whisper-tiny.en' : 'whisper-small.en'
}

export const DICTATION_WHISPER_REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
] as const

export const DICTATION_WHISPER_OPTIONAL_FILES = ['generation_config.json'] as const
