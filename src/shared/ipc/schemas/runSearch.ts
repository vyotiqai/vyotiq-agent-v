import { z } from 'zod'

/** Search inside tasks: titles, then what was said in them. */
export const RunSearchRequestSchema = z.object({
  workspacePaths: z.array(z.string().min(1)).min(1).max(20),
  query: z.string().trim().min(2).max(200),
  maxResults: z.number().int().min(1).max(200).default(50)
})
export type RunSearchRequest = z.infer<typeof RunSearchRequestSchema>

export const RunSearchHitSchema = z.object({
  workspacePath: z.string(),
  runId: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  status: z.string(),
  /** Where the match is: the title, or a message by you, the agent, or a tool. */
  where: z.enum(['title', 'you', 'agent', 'tool']),
  /** One line around the match; `matchStart`/`matchLength` locate it in there. */
  snippet: z.string(),
  matchStart: z.number().int().min(0),
  matchLength: z.number().int().min(0)
})
export type RunSearchHit = z.infer<typeof RunSearchHitSchema>

export const RunSearchResultSchema = z.object({
  hits: z.array(RunSearchHitSchema),
  /** A bound (results, time, bytes per task) cut the search short. */
  truncated: z.boolean(),
  scannedRuns: z.number().int().min(0)
})
export type RunSearchResult = z.infer<typeof RunSearchResultSchema>
