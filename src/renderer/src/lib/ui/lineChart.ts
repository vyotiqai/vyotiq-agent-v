export type LinePoint = {
  x: number
  y: number
  value: number
  index: number
}

/** Catmull-Rom → cubic bezier: the gentle curve every Vyotiq line chart uses. */
export function smoothLinePath(points: readonly LinePoint[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[Math.min(points.length - 1, i + 2)]!
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  return d
}

export type LineSegments = {
  /** Continuous runs of measured points; null/zero values split the line. */
  segments: LinePoint[][]
  max: number
  total: number
}

/**
 * Shared geometry for area-line charts: x centered per slot, y scaled against
 * the window's peak with an 8px top / 4px bottom pad. Nulls and zeros split
 * the line — a missing measurement is a gap, never a fake zero dip.
 */
export function buildLineSegments(
  values: readonly (number | null)[],
  width: number,
  height: number
): LineSegments {
  const max = Math.max(0, ...values.filter((v): v is number => v != null))
  const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0)
  if (max <= 0) return { segments: [], max: 0, total }
  let current: LinePoint[] = []
  const segments: LinePoint[][] = []
  values.forEach((value, index) => {
    if (value == null || value <= 0) {
      if (current.length > 0) segments.push(current)
      current = []
      return
    }
    current.push({
      x: ((index + 0.5) / values.length) * width,
      y: height - 4 - (value / max) * (height - 12),
      value,
      index
    })
  })
  if (current.length > 0) segments.push(current)
  return { segments, max, total }
}
