/**
 * Shared ARC-AGI evaluator contract (Waves 1, 2a, 2b import this file).
 * Do not rename or reshape anything here.
 */
export type ArcGrid = number[][]

export interface ArcExample {
  input: ArcGrid
  output: ArcGrid
}

export interface ArcTask {
  id: string
  train: ArcExample[]
  test: ArcExample[]
}

export interface ArcCandidate {
  index: number
  prediction: ArcGrid | null
  error?: string
  durationMs: number
}

export interface ArcTaskResult {
  taskId: string
  candidates: ArcCandidate[]
  voted: ArcGrid | null
  pass1: boolean
  passVote: boolean
}

export interface ArcEvalReport {
  startedAt: string
  model: string
  taskCount: number
  candidateCount: number
  results: ArcTaskResult[]
  pass1Rate: number
  passVoteRate: number
  totalDurationMs: number
}
