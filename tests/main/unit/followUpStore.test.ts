import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  clearFollowUps,
  loadFollowUpPreviews,
  loadFollowUps,
  saveFollowUps,
  syncFollowUpsToDisk,
  hydrateFollowUpsFromDisk
} from '@main/agent/followUpStore'
import {
  enqueueFollowUp,
  peekFollowUps,
  resetActiveRunsForTests,
  registerRunAbort
} from '@main/agent/runRegistry'
import { logger } from '@shared/logger'

describe('followUpStore', () => {
  let runDir: string
  const runId = 'followup-store-run'

  beforeEach(() => {
    runDir = join(tmpdir(), `vyotiq-followup-store-${process.pid}-${Date.now()}`)
    mkdirSync(runDir, { recursive: true })
    resetActiveRunsForTests()
    registerRunAbort(runId, '/tmp/workspace')
  })

  afterEach(() => {
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
    resetActiveRunsForTests()
  })

  it('round-trips save/load/clear', () => {
    const entries = [
      { id: 'a', message: { role: 'user' as const, content: 'first' }, ready: true },
      { id: 'b', message: { role: 'user' as const, content: 'second' } }
    ]
    saveFollowUps(runDir, entries)
    expect(loadFollowUps(runDir)).toEqual(entries)
    expect(loadFollowUpPreviews(runDir)).toEqual([
      { id: 'a', preview: 'first', ready: true },
      { id: 'b', preview: 'second' }
    ])
    clearFollowUps(runDir)
    expect(loadFollowUps(runDir)).toEqual([])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(false)
  })

  it('syncs registry queue to disk and hydrates back', () => {
    enqueueFollowUp(runId, { role: 'user', content: 'queued on disk' })
    syncFollowUpsToDisk(runDir, runId)
    resetActiveRunsForTests()
    registerRunAbort(runId, '/tmp/workspace')
    expect(peekFollowUps(runId)).toEqual([])
    hydrateFollowUpsFromDisk(runDir, runId)
    expect(peekFollowUps(runId)).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        message: { role: 'user', content: 'queued on disk' }
      })
    ])
  })

  it('clears disk file when queue is empty', () => {
    saveFollowUps(runDir, [{ id: 'x', message: { role: 'user', content: 'gone' } }])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(true)
    saveFollowUps(runDir, [])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(false)
  })

  it('warns and returns [] when followups.json is corrupt', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      // Unparsable JSON — catch path warns.
      writeFileSync(join(runDir, 'followups.json'), '{ not json', 'utf8')
      expect(loadFollowUps(runDir)).toEqual([])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('followups.json')
      // Valid JSON, wrong shape — schema-failure path warns too.
      writeFileSync(join(runDir, 'followups.json'), JSON.stringify({ nope: true }), 'utf8')
      expect(loadFollowUps(runDir)).toEqual([])
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
