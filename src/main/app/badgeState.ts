/**
 * Badge state machine — pure and electron-free so it stays unit-testable
 * (same pattern as app/secondInstance.ts). One badge shows at a time, ranked
 * by urgency: an agent blocked on the user beats unread results, which beats a
 * quiet run still working.
 */

export type BadgeInput = {
  pendingApprovals: number
  pendingQuestions: number
  unreadNotifications: number
  activeRuns: number
}

export type BadgeState =
  | { kind: 'needsyou'; count: number }
  | { kind: 'unread'; count: number }
  | { kind: 'working' }
  | { kind: 'idle' }

/** Highest count with a rendered asset; above this the badge shows "9+". */
export const BADGE_MAX_COUNT = 10

export function computeBadgeState(input: BadgeInput): BadgeState {
  const blocked = Math.max(0, input.pendingApprovals) + Math.max(0, input.pendingQuestions)
  if (blocked > 0) {
    return { kind: 'needsyou', count: Math.min(blocked, BADGE_MAX_COUNT) }
  }
  const unread = Math.max(0, input.unreadNotifications)
  if (unread > 0) {
    return { kind: 'unread', count: Math.min(unread, BADGE_MAX_COUNT) }
  }
  if (input.activeRuns > 0) {
    return { kind: 'working' }
  }
  return { kind: 'idle' }
}

/**
 * macOS dock dialect: the dock badge is text-only and conventionally red, so
 * state rides on content — a number for unread, "!" for attention, a dot for
 * working. Empty string clears the badge.
 */
export function dockBadgeTextFor(state: BadgeState): string {
  switch (state.kind) {
    case 'needsyou':
      return '!'
    case 'unread':
      return String(state.count)
    case 'working':
      return '•'
    case 'idle':
      return ''
  }
}
