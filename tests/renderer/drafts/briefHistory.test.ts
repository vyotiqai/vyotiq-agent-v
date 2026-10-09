/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BRIEF_HISTORY_MAX,
  createBriefHistoryCursor,
  readBriefHistory,
  recordBrief
} from '@renderer/lib/drafts/briefHistory'

beforeEach(() => window.localStorage.clear())

describe('brief history', () => {
  it('keeps sent briefs newest first, once each, up to the cap', () => {
    recordBrief('Fix the flaky test')
    recordBrief('Add rate limiting')
    recordBrief('Fix the flaky test')
    recordBrief('   ')
    expect(readBriefHistory()).toEqual(['Fix the flaky test', 'Add rate limiting'])
    for (let i = 0; i < BRIEF_HISTORY_MAX + 5; i += 1) recordBrief(`brief ${i}`)
    expect(readBriefHistory()).toHaveLength(BRIEF_HISTORY_MAX)
  })

  it('walks back with ↑ from an empty field, forward with ↓, and clears past the newest', () => {
    recordBrief('one')
    recordBrief('two')
    const cursor = createBriefHistoryCursor()
    expect(cursor.older('')).toBe('two')
    expect(cursor.older('two')).toBe('one')
    expect(cursor.older('one')).toBeNull()
    expect(cursor.newer('one')).toBe('two')
    expect(cursor.newer('two')).toBe('')
    expect(cursor.newer('')).toBeNull()
  })

  it('stops walking once the field is edited, so ↑ moves the caret again', () => {
    recordBrief('one')
    const cursor = createBriefHistoryCursor()
    expect(cursor.older('')).toBe('one')
    expect(cursor.older('one, but edited')).toBeNull()
    expect(cursor.newer('one, but edited')).toBeNull()
    expect(cursor.older('a new brief')).toBeNull()
  })
})
