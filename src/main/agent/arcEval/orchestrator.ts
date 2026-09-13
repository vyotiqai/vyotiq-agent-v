import { scorePrediction, majorityVote } from './arcScorer'
import type { ArcCandidate, ArcGrid, ArcTask, ArcTaskResult } from './types'

/**
 * A solver produces one candidate attempt for a task. The orchestrator never
 * inspects how the solver works — Wave 2a's harness adapter and the CLI's stub
 * both plug in through this interface.
 */
export type TaskSolver = (task: ArcTask, candidateIndex: number) => Promise<ArcCandidate>

export interface RunEvalOptions {
  /** Number of solver attempts per task (candidate indices 0..count-1). */
  candidateCount: number
  /** Maximum number of TASKS processed concurrently (each task still fans out its candidates). */
  concurrency: number
  /** Optional model label carried into the report metadata. */
  model?: string
}

/**
 * Run every task through the injected solver with `candidateCount` attempts
 * per task, at most `concurrency` tasks in flight at once.
 *
 * A solver rejection NEVER escapes: it becomes an ArcCandidate with `error`
 * set and `prediction: null` (durationMs 0), so the run always completes.
 *
 * Scoring per task:
 *   pass1    — first candidate (index 0) matches task.test[0].output exactly
 *   passVote — majorityVote over all candidates matches task.test[0].output
 */
export async function runEvalTasks(
  tasks: ArcTask[],
  solver: TaskSolver,
  opts: RunEvalOptions
): Promise<ArcTaskResult[]> {
  const { candidateCount, concurrency } = opts
  const results: ArcTaskResult[] = new Array(tasks.length)
  let nextIndex = 0

  async function runCandidate(task: ArcTask, candidateIndex: number): Promise<ArcCandidate> {
    try {
      return await solver(task, candidateIndex)
    } catch (err) {
      return {
        index: candidateIndex,
        prediction: null,
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0
      }
    }
  }

  async function runTask(task: ArcTask): Promise<ArcTaskResult> {
    const candidates: ArcCandidate[] = []
    for (let i = 0; i < candidateCount; i++) {
      candidates.push(await runCandidate(task, i))
    }
    const expected: ArcGrid | null = task.test[0]?.output ?? null
    const pass1 = scorePrediction(expected, candidates[0]?.prediction ?? null)
    const voted = majorityVote(candidates.map((c) => c.prediction))
    const passVote = scorePrediction(expected, voted)
    return { taskId: task.id, candidates, voted, pass1, passVote }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++
      if (index >= tasks.length) return
      results[index] = await runTask(tasks[index])
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}
