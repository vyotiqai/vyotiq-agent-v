export {
  PLAN_BODY_MIN_CHARS,
  isPlanDraftReady,
  minimalReadyPlanMarkdown,
  planDraftBodyLines
} from '@shared/planQuality'

/**
 * Minimal legacy stub shape. Real Plan-mode stubs (`DEFAULT_PLAN_STUB`)
 * are the Goal / Steps / Done when outline — readiness needs real body text, not the empty stub.
 */
export const PLAN_STUB = [
  '# Plan',
  '',
  '_Draft the plan here. Update as you learn. Do not edit product source in Plan mode._',
  ''
].join('\n')
