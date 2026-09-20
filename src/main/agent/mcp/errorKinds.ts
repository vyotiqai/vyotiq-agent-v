/**
 * Error-shape predicates shared by the connect pipeline and the classifier.
 *
 * They live here rather than in `index.ts` so `connectErrors.ts` can use them
 * without importing the module that imports it. `index.ts` re-exports them, so
 * every existing caller keeps working.
 */

/** Recorded instead of a raw 401 when a server needs the user to sign in. */
export const MCP_SIGN_IN_REQUIRED = 'Sign in required'

export function isMcpSignInRequiredError(message: string | null | undefined): boolean {
  if (!message) return false
  return /sign in required/i.test(message)
}

export function isMcpMissingBinaryError(message: string | null | undefined): boolean {
  if (!message) return false
  return /was not found on PATH/i.test(message)
}
