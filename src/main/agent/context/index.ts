export {
  assembleContext,
  clearSystemPromptCache
} from './assemble'
export { allocateBudget, contextWindowFor, effectiveWindow, contentWindow } from './budget'
export {
  compactMessages,
  countUserTurns,
  forceCompactKeepTail,
  ensureSubstantialFold,
  manualKeepRecentTurns,
  buildCompactionSystemPrompt,
  preserveRecentMessagesAsync
} from './compact'
export {
  estimateMessagesTokensAsync,
  estimateTextTokens,
  estimateTextTokensAsync,
  shouldTriggerAutoCompact
} from './estimate'
export {
  countTextTokens,
  countTextTokensAsync,
  countTextsTokensAsync,
  encodingForModel,
  getTokenizerPerfStats,
  resetTokenizerCache,
  resetTokenizerPerfStats
} from './tokenizer'
export { resetTokenizerPoolForTests } from './tokenizerPool'
export { estimateImageTokens, imageDimensionsFromDataUrl, imageTokensForDimensions } from './imageTokens'
export {
  ensureMemoryLayout,
  listMemoryNotes,
  readMemoryFile,
  readMemoryIndex,
  readMemoryIndexAsync,
  readMemoryState,
  readMemoryStateAsync,
  writeMemoryFile,
  memoryRoot
} from './memory'
export {
  buildStepToolCatalog,
  isOptionalBuiltinName,
  OPTIONAL_BUILTIN_NAMES
} from './toolsBudget'
export {
  extractAskQuestionDecisions,
  parseAskQuestionResult,
  loopHintForRetainedDecisions,
  mergeCompactionFocus
} from './retainedDecisions'
export {
  extractFoldFacts,
  extractUserConstraints,
  parseContractGoal,
  parseContractDoneWhen,
  collectPathsFromText,
  isPlausibleWorkspaceFilePath
} from './foldFacts'
export type { FoldFacts, FoldFactsExtras } from './foldFacts'
export {
  pinFoldFacts,
  mergeFoldFacts,
  foldFactsToPinned,
  pinnedFactsToFoldFacts,
  formatPinnedFacts
} from './pinFoldFacts'
export type { PinnedFoldFacts } from './pinFoldFacts'
export {
  verifyCompactionSummary,
  formatCompactionVerifyFailure,
  missingFactsFocus,
  requiredFoldFactsFocus,
  expandBraceGlobs,
  extractClaimedPaths,
  pathMentionedInText,
  factMentionedInText,
  FILE_COVERAGE_RATIO,
  FILE_COVERAGE_MAX_NEEDED,
  MAX_VERIFY_FAILURES,
  clipVerifyFailures
} from './verifyCompaction'
export type {
  CompactionVerifyResult,
  CompactionVerifyFailure,
  CompactionVerifyFailureKind
} from './verifyCompaction'
export {
  applyFoldedMessagesWatermark,
  stripLeadingOrphanToolMessages,
  stripOrphanToolMessages
} from './foldWatermark'
export { buildWorkspaceSnapshot, buildWorkspaceSnapshotAsync, clearWorkspaceSnapshotCache } from './workspaceSnapshot'
export {
  buildWorkspaceRulesSection,
  clearRulesCache,
  formatWorkspaceRules,
  isRuleRelatedRelPath,
  readWorkspaceRules
} from './rules'
export { formatUserRules } from './userRules'
export { buildSessionEnvSection } from './sessionEnv'
export type { AssembleResult, CompactionRecord, AssembleInput } from './types'
