import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

describe('Sentry preload gate', () => {
  it('preload does not unconditionally call Sentry.init', () => {
    const preloadPath = join(process.cwd(), 'src/preload/index.ts')
    const source = readFileSync(preloadPath, 'utf8')
    expect(source).not.toMatch(/Sentry\.init\s*\(/)
    expect(source).not.toMatch(/@sentry\/electron\/renderer/)
  })
})
