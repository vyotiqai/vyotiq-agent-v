import { z } from 'zod'

/** Settings › General › Command line: whether `vyotiq` is on your PATH. */
export const CliPathStatusSchema = z.object({
  /** False where the app can't add it: not Windows, or not an installed app. */
  available: z.boolean(),
  onPath: z.boolean(),
  /** The folder holding `vyotiq.cmd`, or null when there is none. */
  dir: z.string().nullable()
})
export type CliPathStatus = z.infer<typeof CliPathStatusSchema>

export const CliPathSetRequestSchema = z.object({ onPath: z.boolean() })
export type CliPathSetRequest = z.infer<typeof CliPathSetRequestSchema>
