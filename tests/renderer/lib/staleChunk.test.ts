/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  isStaleChunkFailure,
  rearmStaleChunkReload,
  resetStaleChunkReloadFlagForTests,
  takeStaleChunkReload
} from '@renderer/lib/staleChunk'

describe('staleChunk recovery', () => {
  beforeEach(() => {
    resetStaleChunkReloadFlagForTests()
  })

  it('detects failed dynamic module imports across Chromium message shapes', () => {
    expect(
      isStaleChunkFailure(
        new TypeError(
          'Failed to fetch dynamically imported module: file:///C:/app/out/renderer/assets/FilesPanel-BXMtR6pW.js'
        )
      )
    ).toBe(true)
    expect(isStaleChunkFailure(new Error('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkFailure('error loading dynamically imported module x')).toBe(true)
    expect(isStaleChunkFailure(new TypeError('boom'))).toBe(false)
    expect(isStaleChunkFailure('plain failure')).toBe(false)
    expect(isStaleChunkFailure(undefined)).toBe(false)
    expect(isStaleChunkFailure({ message: 'Failed to fetch dynamically imported module' })).toBe(
      false
    )
  })

  it('allows exactly one automatic reload until re-armed', () => {
    expect(takeStaleChunkReload()).toBe(true)
    expect(takeStaleChunkReload()).toBe(false)
    rearmStaleChunkReload()
    expect(takeStaleChunkReload()).toBe(true)
  })
})
