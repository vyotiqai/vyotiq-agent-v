import { z } from 'zod'

/**
 * Agent-emitted chart specs — the body of a ```chart fenced block. The fence
 * comes from model output, which is untrusted input: every limit here is a
 * hard cap (raw size, point count, magnitude, label length) so one reply
 * cannot push a pathological DOM into the transcript. Parse failures make the
 * fence fall back to a plain code block, never an error.
 */

/** Raw fence-body cap before JSON parsing is even attempted. */
export const CHART_SPEC_MAX_CHARS = 8_000
/** Line/bar point cap — a month of daily data plus headroom. */
export const CHART_MAX_POINTS = 60
/** Donut slice cap — past ~8 slices the ring stops being readable. */
export const CHART_MAX_SLICES = 8

const LABEL_MAX = 80
const VALUE_MAX = 1e12

const titleSchema = z.string().max(LABEL_MAX).optional()

/** Series values are non-negative; null is an honest gap, never a zero. */
const seriesSchema = z
  .array(z.number().finite().min(0).max(VALUE_MAX).nullable())
  .min(1)
  .max(CHART_MAX_POINTS)

const labelsSchema = z.array(z.string().max(LABEL_MAX)).max(CHART_MAX_POINTS)

// Discriminated-union options must be plain ZodObjects (a .refine would wrap
// them in ZodEffects), so label/value length parity is enforced in the parser.
const lineBarSchema = z.object({
  type: z.enum(['line', 'bar']),
  title: titleSchema,
  labels: labelsSchema,
  values: seriesSchema
})

const donutSchema = z.object({
  type: z.literal('donut'),
  title: titleSchema,
  labels: z.array(z.string().max(LABEL_MAX)).min(2).max(CHART_MAX_SLICES),
  values: z
    .array(z.number().finite().min(0).max(VALUE_MAX))
    .min(2)
    .max(CHART_MAX_SLICES)
})

const sparklineSchema = z.object({
  type: z.literal('sparkline'),
  title: titleSchema,
  values: seriesSchema.min(2)
})

export const ChartSpecSchema = z.discriminatedUnion('type', [
  lineBarSchema,
  donutSchema,
  sparklineSchema
])

export type ChartSpec = z.infer<typeof ChartSpecSchema>

/** Parse a ```chart fence body; null means "render as a plain code block". */
export function parseChartSpec(raw: string): ChartSpec | null {
  const text = raw.trim()
  if (text.length === 0 || text.length > CHART_SPEC_MAX_CHARS) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = ChartSpecSchema.safeParse(json)
  if (!parsed.success) return null
  const spec = parsed.data
  if (spec.type !== 'sparkline' && spec.labels.length !== spec.values.length) return null
  return spec
}
