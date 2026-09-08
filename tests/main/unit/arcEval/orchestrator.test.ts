import { describe, expect, it } from 'vitest'
import { runEvalTasks } from '../../../../src/main/agent/arcEval/orchestrator'
import { buildReport, formatConsole } from '../../../../src/main/agent/arcEval/report'
import type { ArcCandidate, ArcGrid, ArcTask, ArcTaskResult } from '../../../../src/main/agent/arcEval/types'

const grid = (...rows: number[][]): ArcGrid => rows

function makeTask(id: string, output: ArcGrid): ArcTask {
  return { id, train: [], test: [{ input: grid([0]), output }] }
}

/** Solver that always returns the given grid (or null). */
function constantSolver(value: ArcGrid | null, durationMs = 5) {
  return async (task: ArcTask, candidateIndex: number): Promise<ArcCandidate> => ({
    index: candidateIndex,
    prediction: value === null ? null : value.map((row) => [...row]),
    durationMs
  })
}

/** Solver that emits value only for the requested candidate index. */
function perIndexSolver(values: (ArcGrid | null | 'reject')[]) {
  return async (task: ArcTask, candidateIndex: number): Promise<ArcCandidate> => {
    const value = values[candidateIndex] ?? null
    if (value === 'reject') throw new Error(`solver exploded for index ${candidateIndex}`)
    return {
      index: candidateIndex,
      prediction: value === null ? null : value.map((row) => [...row]),
      durationMs: 3
    }
  }
}

describe('runEvalTasks', () => {
  it('all candidates correct: pass1 and passVote both true', async () => {
    const expected = grid([1, 2], [3, 4])
    const results = await runEvalTasks([makeTask('t1', expected)], constantSolver(expected), {
      candidateCount: 3,
      concurrency: 2
    })
    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.taskId).toBe('t1')
    expect(r.pass1).toBe(true)
    expect(r.passVote).toBe(true)
    expect(r.candidates).toHaveLength(3)
    expect(r.voted).toEqual(expected)
  })

  it('all candidates wrong: pass1 and passVote both false', async () => {
    const expected = grid([1])
    const wrong = grid([9])
    const results = await runEvalTasks([makeTask('t1', expected)], constantSolver(wrong), {
      candidateCount: 2,
      concurrency: 2
    })
    const r = results[0]
    expect(r.pass1).toBe(false)
    expect(r.passVote).toBe(false)
    expect(r.voted).toEqual(wrong)
  })

  it('all candidates null: passVote false and voted is null', async () => {
    const results = await runEvalTasks([makeTask('t1', grid([1]))], constantSolver(null), {
      candidateCount: 2,
      concurrency: 1
    })
    const r = results[0]
    expect(r.pass1).toBe(false)
    expect(r.passVote).toBe(false)
    expect(r.voted).toBeNull()
  })

  it('mixed candidates: majority vote flips passVote to true while pass1 is false', async () => {
    const expected = grid([5, 5])
    const wrong = grid([0, 0])
    // candidate 0 wrong, candidates 1 and 2 correct -> correct grid wins 2-1
    const results = await runEvalTasks([makeTask('t1', expected)], perIndexSolver([wrong, expected, expected]), {
      candidateCount: 3,
      concurrency: 1
    })
    const r = results[0]
    expect(r.pass1).toBe(false)
    expect(r.passVote).toBe(true)
    expect(r.voted).toEqual(expected)
  })

  it('majority tie: majorityVote first-to-count rule decides passVote deterministically', async () => {
    const expected = grid([7])
    const other = grid([8, 8])
    // [wrong, correct] -> 1-1 tie; wrong came first -> wins the vote -> passVote false
    const tieWrongFirst = await runEvalTasks([makeTask('t1', expected)], perIndexSolver([other, expected]), {
      candidateCount: 2,
      concurrency: 1
    })
    expect(tieWrongFirst[0].pass1).toBe(false)
    expect(tieWrongFirst[0].passVote).toBe(false)
    expect(tieWrongFirst[0].voted).toEqual(other)

    // Reversed order: correct came first -> wins the tie -> passVote true
    const tieCorrectFirst = await runEvalTasks([makeTask('t1', expected)], perIndexSolver([expected, other]), {
      candidateCount: 2,
      concurrency: 1
    })
    expect(tieCorrectFirst[0].pass1).toBe(true)
    expect(tieCorrectFirst[0].passVote).toBe(true)
    expect(tieCorrectFirst[0].voted).toEqual(expected)
  })

  it('solver rejection becomes an error candidate with null prediction and never crashes the run', async () => {
    const expected = grid([1, 2, 3])
    const results = await runEvalTasks(
      [makeTask('boom', expected), makeTask('fine', expected)],
      async (task, candidateIndex) => {
        if (task.id === 'boom') throw new Error('kaboom')
        return { index: candidateIndex, prediction: expected.map((row) => [...row]), durationMs: 1 }
      },
      { candidateCount: 2, concurrency: 2 }
    )
    const boom = results.find((r: ArcTaskResult) => r.taskId === 'boom')
    expect(boom).toBeDefined()
    expect(boom?.candidates).toHaveLength(2)
    for (const c of boom?.candidates ?? []) {
      expect(c.prediction).toBeNull()
      expect(c.error).toBe('kaboom')
    }
    expect(boom?.pass1).toBe(false)
    expect(boom?.passVote).toBe(false)

    // The sibling task ran to completion despite the rejection.
    const fine = results.find((r: ArcTaskResult) => r.taskId === 'fine')
    expect(fine?.pass1).toBe(true)
    expect(fine?.passVote).toBe(true)
  })

  it('respects bounded concurrency: peak in-flight tasks never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const tasks: ArcTask[] = Array.from({ length: 9 }, (_, i) =>
      makeTask(`t${i}`, grid([i]))
    )
    const trackingSolver = async (task: ArcTask, candidateIndex: number): Promise<ArcCandidate> => {
      // runEvalTasks fans candidates out sequentially per task, so each
      // solver entry here is one task holding a concurrency slot.
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return { index: candidateIndex, prediction: grid([Number(task.id.slice(1))]), durationMs: 5 }
    }
    const results = await runEvalTasks(tasks, trackingSolver, { candidateCount: 2, concurrency: 3 })
    expect(results).toHaveLength(9)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(0)
  })

  it('processes every task even when concurrency exceeds the task count', async () => {
    const tasks = [makeTask('a', grid([1])), makeTask('b', grid([2]))]
    const results = await runEvalTasks(tasks, constantSolver(grid([1])), {
      candidateCount: 1,
      concurrency: 16
    })
    expect(results.map((r) => r.taskId)).toEqual(['a', 'b'])
  })
})

describe('buildReport', () => {
  it('computes rates and total duration from candidate durations', () => {
    const results: ArcTaskResult[] = [
      {
        taskId: 'a',
        candidates: [
          { index: 0, prediction: grid([1]), durationMs: 10 },
          { index: 1, prediction: grid([1]), durationMs: 20 }
        ],
        voted: grid([1]),
        pass1: true,
        passVote: true
      },
      {
        taskId: 'b',
        candidates: [{ index: 0, prediction: null, error: 'x', durationMs: 0 }],
        voted: null,
        pass1: false,
        passVote: false
      },
      {
        taskId: 'c',
        candidates: [
          { index: 0, prediction: grid([2]), durationMs: 30 },
          { index: 1, prediction: grid([3]), durationMs: 40 },
          { index: 2, prediction: grid([2]), durationMs: 50 }
        ],
        voted: grid([2]),
        pass1: false,
        passVote: true
      }
    ]
    const report = buildReport(results, {
      model: 'stub',
      candidateCount: 3,
      startedAt: '2026-09-08T00:00:00.000Z'
    })
    expect(report.taskCount).toBe(3)
    expect(report.pass1Rate).toBeCloseTo(1 / 3)
    expect(report.passVoteRate).toBeCloseTo(2 / 3)
    expect(report.totalDurationMs).toBe(10 + 20 + 0 + 30 + 40 + 50)
    expect(report.model).toBe('stub')
    expect(report.candidateCount).toBe(3)
    expect(report.startedAt).toBe('2026-09-08T00:00:00.000Z')
    expect(report.results).toBe(results)
  })

  it('returns zero rates and zero duration for an empty result set', () => {
    const report = buildReport([], { model: 'stub', candidateCount: 1, startedAt: 'x' })
    expect(report.taskCount).toBe(0)
    expect(report.pass1Rate).toBe(0)
    expect(report.passVoteRate).toBe(0)
    expect(report.totalDurationMs).toBe(0)
  })
})

describe('formatConsole', () => {
  it('renders a compact emoji-free table and summary', () => {
    const results: ArcTaskResult[] = [
      {
        taskId: 'task-a',
        candidates: [{ index: 0, prediction: grid([1]), durationMs: 12 }],
        voted: grid([1]),
        pass1: true,
        passVote: true
      },
      {
        taskId: 'task-b',
        candidates: [{ index: 0, prediction: null, error: 'boom', durationMs: 0 }],
        voted: null,
        pass1: false,
        passVote: false
      }
    ]
    const report = buildReport(results, { model: 'stub', candidateCount: 1, startedAt: '2026-09-08T00:00:00.000Z' })
    const out = formatConsole(report)
    expect(out).toContain('pass@1:        50.0% (1/2)')
    expect(out).toContain('pass@vote:     50.0% (1/2)')
    expect(out).toContain('task-a')
    expect(out).toContain('task-b')
    expect(out).toContain('total duration: 12 ms')
    // no emoji / no fancy glyphs beyond ASCII + ellipsis-free ids
    for (const ch of out) {
      expect(ch.charCodeAt(0)).toBeLessThan(128)
    }
  })
})
