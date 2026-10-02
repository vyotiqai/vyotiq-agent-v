/** Sum of a list of numbers (0 for an empty list). */
export function sum(values) {
  return values.reduce((total, v) => total + v, 0)
}

/** Arithmetic mean; NaN for an empty list. */
export function mean(values) {
  return values.length === 0 ? Number.NaN : sum(values) / values.length
}
