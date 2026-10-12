import { z } from 'zod'

export const PtySessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  cwd: z.string(),
  running: z.boolean(),
  /** 'agent' is a read-only mirror of the run's own commands — no process. */
  backend: z.enum(['pty', 'pipe', 'agent']).optional()
})
export type PtySessionInfo = z.infer<typeof PtySessionSchema>

/** Which shell a new terminal tab runs; `default` follows Settings. WSL is Windows only. */
export const PtyShellChoiceSchema = z.enum(['default', 'powershell', 'cmd', 'bash', 'wsl'])
export type PtyShellChoice = z.infer<typeof PtyShellChoiceSchema>

export const PtyCreateRequestSchema = z.object({
  workspacePath: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  shell: PtyShellChoiceSchema.optional()
})

export const PtyRenameRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1),
  title: z.string().trim().min(1).max(60)
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

/** A background process the agent started that kept running past its turn. */
export const KeptTerminalSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  workspacePath: z.string(),
  command: z.string(),
  cwd: z.string(),
  startedAt: z.string()
})
export type KeptTerminalInfo = z.infer<typeof KeptTerminalSchema>

export const TerminalKeptListRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const TerminalKeptStopRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1)
})

export const PtyResizeRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
})
