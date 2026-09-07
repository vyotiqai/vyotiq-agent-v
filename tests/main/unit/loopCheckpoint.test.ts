import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  clearLoopCheckpoint,
  loadLoopCheckpoint,
  LOOP_CHECKPOINT_FILENAME,
  saveLoopCheckpoint
} from '@main/agent/loopCheckpoint'
import { LOOP_CHECKPOINT_VERSION } from '@shared/ipc/schemas/agent'

const root = join(tmpdir(), `vyotiq-loop-cp-${process.pid}-${Date.now()}`)

describe('loopCheckpoint', () => {
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips checkpoint fields via atomic write', () => {
    const runDir = join(root, 'run-1')
    mkdirSync(runDir, { recursive: true })
    const checkpoint = {
      version: LOOP_CHECKPOINT_VERSION,
      step: 12,
      invokeId: 3,
      updatedAt: new Date().toISOString(),
      truncationContinues: 1,
      overflowRetryUsed: true,
      identicalStepStreak: 2,
      lastStepFingerprint: 'fp-abc123',
      identicalReasoningStreak: 3,
      lastReasoningFingerprint: 'fp-def456',
      repetitionAborts: 1,
      consecutiveToolFailureSteps: 1,
      recentFailureSignatures: ['sig-1', 'sig-2'],
      emptyResponseContinues: 1,
      goalNoToolFinishes: 2
    }
    saveLoopCheckpoint(runDir, checkpoint)
    expect(existsSync(join(runDir, LOOP_CHECKPOINT_FILENAME))).toBe(true)
    const raw = JSON.parse(readFileSync(join(runDir, LOOP_CHECKPOINT_FILENAME), 'utf8')) as unknown
    expect(raw).toMatchObject({
      step: 12,
      truncationContinues: 1,
      overflowRetryUsed: true
    })
    expect(loadLoopCheckpoint(runDir)).toEqual(checkpoint)
  })

  it('clear removes checkpoint file', () => {
    const runDir = join(root, 'run-2')
    mkdirSync(runDir, { recursive: true })
    saveLoopCheckpoint(runDir, {
      version: LOOP_CHECKPOINT_VERSION,
      step: 0,
      invokeId: 1,
      updatedAt: new Date().toISOString(),
      truncationContinues: 0,
      overflowRetryUsed: false
    })
    clearLoopCheckpoint(runDir)
    expect(loadLoopCheckpoint(runDir)).toBeNull()
  })

  it('migrates a v2 checkpoint (pre-usageTotals) to the current version', () => {
    const runDir = join(root, 'run-v2')
    mkdirSync(runDir, { recursive: true })
    // A real v2 file: no usageTotals field, version literal 2.
    const legacy = {
      version: 2,
      step: 105,
      invokeId: 3,
      updatedAt: '2026-08-29T08:07:53.081Z',
      truncationContinues: 0,
      overflowRetryUsed: false,
      identicalStepStreak: 1,
      lastStepFingerprint: '74a5e735e912861f',
      consecutiveToolFailureSteps: 0,
      emptyResponseContinues: 0,
      goalNoToolFinishes: 0
    }
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(join(runDir, LOOP_CHECKPOINT_FILENAME), JSON.stringify(legacy), 'utf8')

    const loaded = loadLoopCheckpoint(runDir)
    expect(loaded).not.toBeNull()
    expect(loaded?.version).toBe(LOOP_CHECKPOINT_VERSION)
    // Invariants survive the migration.
    expect(loaded?.step).toBe(105)
    expect(loaded?.identicalStepStreak).toBe(1)
    // recentFailureSignatures postdates v2 files — parses to an empty window.
    expect(loaded?.recentFailureSignatures).toEqual([])
    expect(loaded?.usageTotals).toBeUndefined()
  })

  it('round-trips v3 usageTotals through save/load', () => {
    const runDir = join(root, 'run-v3')
    mkdirSync(runDir, { recursive: true })
    saveLoopCheckpoint(runDir, {
      version: LOOP_CHECKPOINT_VERSION,
      step: 108,
      invokeId: 3,
      updatedAt: new Date().toISOString(),
      truncationContinues: 0,
      overflowRetryUsed: false,
      usageTotals: {
        billedInputTokens: 8_688_647,
        peakInputTokens: 197_566,
        outputTokens: 23_274,
        billedCachedInputTokens: 326_400,
        cacheCreationInputTokens: 0,
        reasoningTokens: 22_822,
        steps: 105,
        stepsWithCacheReport: 90,
        billedCost: 1.234,
        billedCostSaved: 0,
        stepsWithCostReport: 105,
        generationMs: 4_200_000,
        lastStepInputTokens: 124_395
      }
    })
    const loaded = loadLoopCheckpoint(runDir)
    expect(loaded?.usageTotals?.billedInputTokens).toBe(8_688_647)
    expect(loaded?.usageTotals?.steps).toBe(105)
    expect(loaded?.usageTotals?.lastStepInputTokens).toBe(124_395)
  })

  it('parses a v3 checkpoint written before the reasoning-streak fields with additive defaults', () => {
    const runDir = join(root, 'run-v3-legacy')
    mkdirSync(runDir, { recursive: true })
    // A real v3 file from before the identical-reasoning / repetition-abort
    // fields: the three additive fields are absent entirely. LOOP_CHECKPOINT_VERSION
    // is unchanged (still 3), so resume must parse with defaults 0 / '' / 0.
    const legacy = {
      version: LOOP_CHECKPOINT_VERSION,
      step: 105,
      invokeId: 3,
      updatedAt: '2026-09-01T08:07:53.081Z',
      truncationContinues: 0,
      overflowRetryUsed: false,
      identicalStepStreak: 1,
      lastStepFingerprint: '74a5e735e912861f',
      consecutiveToolFailureSteps: 0,
      emptyResponseContinues: 0,
      goalNoToolFinishes: 0
    }
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(join(runDir, LOOP_CHECKPOINT_FILENAME), JSON.stringify(legacy), 'utf8')

    const loaded = loadLoopCheckpoint(runDir)
    expect(loaded).not.toBeNull()
    // Additive fields default — old checkpoints keep parsing/resuming.
    expect(loaded?.identicalReasoningStreak).toBe(0)
    expect(loaded?.lastReasoningFingerprint).toBe('')
    expect(loaded?.repetitionAborts).toBe(0)
    // Existing invariants survive.
    expect(loaded?.step).toBe(105)
    expect(loaded?.identicalStepStreak).toBe(1)
    expect(loaded?.lastStepFingerprint).toBe('74a5e735e912861f')
  })
})
