export { transcribeDictation, isDictationFixtureEnabled, DICTATION_FIXTURE_TEXT, pcm16kToWav } from './transcribe'
export { DictationError, isDictationError } from './errors'
export { dictationMicAccess, openMicSettings } from './micAccess'
export {
  installDictationModel,
  unloadDictationModel,
  deleteDictationModelCache,
  transcribeLocalDictation,
  prepareLocalDictation,
  readDictationRuntimeStatus,
  listInstalledDictationModels,
  setDictationWhisperBackendForTests,
  resetDictationLocalStateForTests
} from './local'
export {
  getDictationRuntimeStatus,
  onDictationRuntimeStatus,
  resetDictationRuntimeStatusForTests
} from './modelStatus'
export { setDictationModelsRootOverrideForTests } from './modelPaths'
export { recommendedDictationModelId } from './catalog'
export { getDictationUtilityClient, resetDictationUtilityClientForTests } from './whisperUtilityClient'
