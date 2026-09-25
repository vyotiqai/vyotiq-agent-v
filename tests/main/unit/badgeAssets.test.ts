import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BADGE_MAX_COUNT, badgeAssetFileFor, computeBadgeState } from '@main/app/badgeState'

/**
 * The badge module picks overlay PNGs by name — a missing asset silently clears
 * the badge instead of showing state. Pin the full asset set, and pin the
 * mapping from state to file: pinning only the set let `needsyou` ask for
 * `needsyou-N.png` while the assets shipped as `attention-N.png`, so the most
 * urgent badge never drew and every gate stayed green.
 */
const BADGES_DIR = join(process.cwd(), 'resources', 'badges')

describe('badge overlay assets', () => {
  it('has the working marker', () => {
    expect(existsSync(join(BADGES_DIR, 'working.png'))).toBe(true)
  })

  it('has every count asset for both urgent kinds', () => {
    for (const kind of ['attention', 'unread']) {
      for (let n = 1; n <= 9; n += 1) {
        const file = join(BADGES_DIR, `${kind}-${n}.png`)
        expect(existsSync(file), file).toBe(true)
        expect(statSync(file).size, file).toBeGreaterThan(0)
      }
      const overflow = join(BADGES_DIR, `${kind}-10.png`)
      expect(existsSync(overflow), overflow).toBe(true)
      expect(statSync(overflow).size, overflow).toBeGreaterThan(0)
    }
  })

  it('resolves an existing file for every state the machine can produce', () => {
    const inputs = [
      { pendingApprovals: 0, pendingQuestions: 0, unreadNotifications: 0, activeRuns: 1 },
      ...Array.from({ length: BADGE_MAX_COUNT }, (_, i) => ({
        pendingApprovals: i + 1,
        pendingQuestions: 0,
        unreadNotifications: 0,
        activeRuns: 0
      })),
      ...Array.from({ length: BADGE_MAX_COUNT }, (_, i) => ({
        pendingApprovals: 0,
        pendingQuestions: 0,
        unreadNotifications: i + 1,
        activeRuns: 0
      }))
    ]
    for (const input of inputs) {
      const state = computeBadgeState(input)
      const file = badgeAssetFileFor(state)
      expect(file, JSON.stringify(state)).not.toBeNull()
      const full = join(BADGES_DIR, file!)
      expect(existsSync(full), `${JSON.stringify(state)} -> ${file}`).toBe(true)
    }
  })

  it('draws nothing when idle', () => {
    const idle = computeBadgeState({
      pendingApprovals: 0,
      pendingQuestions: 0,
      unreadNotifications: 0,
      activeRuns: 0
    })
    expect(badgeAssetFileFor(idle)).toBeNull()
  })
})
