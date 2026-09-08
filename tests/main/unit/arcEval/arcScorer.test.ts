import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { majorityVote, scorePrediction } from '../../../../src/main/agent/arcEval/arcScorer'
import type { ArcGrid, ArcTask } from '../../../../src/main/agent/arcEval/types'

const grid = (...rows: number[][]): ArcGrid => rows

describe('scorePrediction', () => {
  it('passes on exact match including shape and cell values', () => {
    const expected = grid([1, 2], [3, 4])
    expect(scorePrediction(expected, grid([1, 2], [3, 4]))).toBe(true)
  })

  it('passes on the empty grid', () => {
    expect(scorePrediction([], [])).toBe(true)
  })

  it('fails on null or undefined predictions', () => {
    const expected = grid([1])
    expect(scorePrediction(expected, null)).toBe(false)
    expect(scorePrediction(expected, undefined as unknown as ArcGrid | null)).toBe(false)
  })

  it('fails on shape mismatch (row count)', () => {
    expect(scorePrediction(grid([1, 2], [3, 4]), grid([1, 2]))).toBe(false)
  })

  it('fails on shape mismatch (column count)', () => {
    expect(scorePrediction(grid([1, 2]), grid([1]))).toBe(false)
    expect(scorePrediction(grid([1]), grid([1, 2]))).toBe(false)
  })

  it('fails on value mismatch while preserving shape', () => {
    expect(scorePrediction(grid([1, 2], [3, 4]), grid([1, 2], [3, 0]))).toBe(false)
    expect(scorePrediction(grid([0]), grid([9]))).toBe(false)
  })
})

describe('majorityVote', () => {
  it('returns the clear winner among non-null predictions', () => {
    const a = grid([1])
    const b = grid([2, 2])
    expect(majorityVote([a, b, b, a, b])).toEqual(b)
  })

  it('breaks ties deterministically: first grid to reach the top count wins', () => {
    const first = grid([7])
    const second = grid([8, 8])
    expect(majorityVote([first, second])).toEqual(first)
    // Same tie, reversed order — the other grid wins.
    expect(majorityVote([second, first])).toEqual(second)
  })

  it('returns null when all predictions are null', () => {
    expect(majorityVote([null, null, null])).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(majorityVote([])).toBeNull()
  })

  it('ignores nulls when a non-null candidate exists', () => {
    const a = grid([5])
    expect(majorityVote([null, a, null])).toEqual(a)
  })

  it('never mutates the returned grid identity confusion: returns the first-seen grid object', () => {
    const a = grid([1])
    const aPrime = grid([1])
    expect(majorityVote([a, aPrime])).toBe(a)
  })
})

describe('real ARC task round-trip (skipped when dataset is not downloaded)', () => {
  const cacheDir =
    process.env.VYOTIQ_ARC_DATA_DIR ?? resolve(__dirname, '../../../../test-results/arc-agi')

  it('scores a real downloaded task exactly as parsed from JSON', () => {
    const trainDir = join(cacheDir, 'training')
    if (!existsSync(trainDir)) {
      console.warn('[arcScorer.test] dataset not present — skipping real-task round-trip')
      return
    }
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const files = readdirSync(trainDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)

    const raw = JSON.parse(readFileSync(join(trainDir, files[0]), 'utf8')) as {
      train: { input: number[][]; output: number[][] }[]
      test: { input: number[][]; output: number[][] }[]
    }
    const task: ArcTask = {
      id: files[0].replace(/\.json$/, ''),
      train: raw.train,
      test: raw.test
    }
    expect(task.train.length).toBeGreaterThan(0)
    expect(task.test.length).toBeGreaterThan(0)

    // Perfect prediction of the first test output must pass; its input must not.
    const expected = task.test[0].output
    expect(scorePrediction(expected, expected)).toBe(true)
    expect(scorePrediction(expected, task.test[0].input)).toBe(false)

    // All-null candidate votes yield null; the real output alone wins a vote.
    expect(majorityVote([null, null])).toBeNull()
    expect(majorityVote([expected, null, expected])).toEqual(expected)
  })
})
