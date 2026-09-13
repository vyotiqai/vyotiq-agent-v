import { z } from 'zod'

export const PtySessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  cwd: z.string(),
  running: z.boolean(),
  backend: z.enum(['pty', 'pipe']).optional()
})
export type PtySessionInfo = z.infer<typeof PtySessionSchema>

export const PtyCreateRequestSchema = z.object({
  workspacePath: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional()
})

export const PtyListRequestSchema = z.object({
  workspacePath: z.string().min(1).optional()
})

export const PtyIdRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1)
})

export const PtyWriteRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1),
  data: z.string()
})

export const PtyResizeRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
})

export const PtyDataEventSchema = z.object({
  id: z.string().min(1),
  data: z.string()
})

export const PtyExitEventSchema = z.object({
  id: z.string().min(1),
  exitCode: z.number().nullable()
})
