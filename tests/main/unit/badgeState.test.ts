import { describe, expect, it } from 'vitest'

import {
  BADGE_MAX_COUNT,
  computeBadgeState,
  dockBadgeTextFor
} from '@main/app/badgeState'

describe('computeBadgeState', () => {
  it('is idle when nothing is pending or running', () => {
    expect(
      computeBadgeState({ pendingApprovals: 0, pendingQuestions: 0, unreadNotifications: 0, activeRuns: 0 })
    ).toEqual({ kind: 'idle' })
  })

  it('ranks blocked agents over everything', () => {
    expect(
      computeBadgeState({ pendingApprovals: 2, pendingQuestions: 1, unreadNotifications: 5, activeRuns: 3 })
    ).toEqual({ kind: 'needsyou', count: 3 })
  })

  it('combines approvals and questions into one blocked count', () => {
    expect(
      computeBadgeState({ pendingApprovals: 1, pendingQuestions: 0, unreadNotifications: 0, activeRuns: 0 })
    ).toEqual({ kind: 'needsyou', count: 1 })
  })

  it('shows unread when nothing is blocked', () => {
    expect(
      computeBadgeState({ pendingApprovals: 0, pendingQuestions: 0, unreadNotifications: 4, activeRuns: 2 })
    ).toEqual({ kind: 'unread', count: 4 })
  })

  it('shows working when only runs are active', () => {
    expect(
      computeBadgeState({ pendingApprovals: 0, pendingQuestions: 0, unreadNotifications: 0, activeRuns: 1 })
    ).toEqual({ kind: 'working' })
  })

  it('caps counts at the highest rendered asset ("9+")', () => {
    const capped = computeBadgeState({
      pendingApprovals: 25,
      pendingQuestions: 0,
      unreadNotifications: 0,
      activeRuns: 0
    })
    expect(capped).toEqual({ kind: 'needsyou', count: BADGE_MAX_COUNT })

    const unreadCapped = computeBadgeState({
      pendingApprovals: 0,
      pendingQuestions: 0,
      unreadNotifications: 73,
      activeRuns: 0
    })
    expect(unreadCapped).toEqual({ kind: 'unread', count: BADGE_MAX_COUNT })
  })

  it('never goes negative on hostile input', () => {
    expect(
      computeBadgeState({ pendingApprovals: -3, pendingQuestions: -2, unreadNotifications: -1, activeRuns: -5 })
    ).toEqual({ kind: 'idle' })
  })
})

describe('dockBadgeTextFor', () => {
  it('uses the dock text dialect for each state', () => {
    expect(dockBadgeTextFor({ kind: 'needsyou', count: 2 })).toBe('!')
    expect(dockBadgeTextFor({ kind: 'unread', count: 4 })).toBe('4')
    expect(dockBadgeTextFor({ kind: 'working' })).toBe('•')
    expect(dockBadgeTextFor({ kind: 'idle' })).toBe('')
  })

  it('shows the capped count, never "9+" (dock text has no room)', () => {
    expect(dockBadgeTextFor({ kind: 'unread', count: 10 })).toBe('10')
  })
})
