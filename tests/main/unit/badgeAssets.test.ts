import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The badge module picks overlay PNGs by name — a missing asset would silently
 * clear the badge instead of showing state. Pin the full asset set.
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
})
