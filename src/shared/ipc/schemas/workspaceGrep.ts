import { z } from 'zod'
import { WorkspacePathSchema } from './files'

export const WorkspaceGrepHitSchema = z.object({
  path: z.string().min(1).max(4_096),
  line: z.number().int().positive(),
  text: z.string().max(8_192)
})
export type WorkspaceGrepHit = z.infer<typeof WorkspaceGrepHitSchema>

export const WorkspaceGrepRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  query: z.string().trim().min(1).max(512),
  include: z.string().trim().max(256).optional(),
  maxResults: z.number().int().min(1).max(500).default(80)
})
export type WorkspaceGrepRequest = z.infer<typeof WorkspaceGrepRequestSchema>

export const WorkspaceGrepResultSchema = z.object({
  hits: z.array(WorkspaceGrepHitSchema).max(500),
  truncated: z.boolean()
})
export type WorkspaceGrepResult = z.infer<typeof WorkspaceGrepResultSchema>
