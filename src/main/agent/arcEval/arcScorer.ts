import type { ArcGrid } from './types'

/**
 * Exact-match ARC scoring. An actual grid passes only when it is non-null,
 * has exactly the expected shape, and every cell value equals the expected
 * cell value.
 */
export function scorePrediction(expected: ArcGrid, actual: ArcGrid | null): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false
  if (actual.length !== expected.length) return false
  for (let r = 0; r < expected.length; r++) {
    const expectedRow = expected[r]
    const actualRow = actual[r]
    if (!Array.isArray(actualRow) || !Array.isArray(expectedRow)) return false
    if (actualRow.length !== expectedRow.length) return false
    for (let c = 0; c < expectedRow.length; c++) {
      if (actualRow[c] !== expectedRow[c]) return false
    }
  }
  return true
}

/**
 * Most-frequent exact grid among non-null predictions.
 *
 * Deterministic tie-break: when several grids share the top count, the one
 * that first reached that count wins (i.e. earliest first occurrence in the
 * input). Returns null when every prediction is null.
 */
export function majorityVote(predictions: (ArcGrid | null)[]): ArcGrid | null {
  const counts = new Map<string, { grid: ArcGrid; count: number; firstIndex: number }>()
  for (let i = 0; i < predictions.length; i++) {
    const grid = predictions[i]
    if (grid == null) continue
    const key = JSON.stringify(grid)
    const entry = counts.get(key)
    if (entry) {
      entry.count++
    } else {
      counts.set(key, { grid, count: 1, firstIndex: i })
    }
  }
  let best: { grid: ArcGrid; count: number; firstIndex: number } | null = null
  for (const entry of counts.values()) {
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && entry.firstIndex < best.firstIndex)
    ) {
      best = entry
    }
  }
  return best ? best.grid : null
}
