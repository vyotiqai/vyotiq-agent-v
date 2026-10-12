import { z } from 'zod'

/** One hooks file as Settings shows it: where it is and what it would run. */
export const HooksFileViewSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  /** "PreToolUse (terminal): ./check.sh", one per hook. */
  commands: z.array(z.string()),
  /** Entries this app does not run (an unsupported event or hook type), as `Event (why)`. */
  skipped: z.array(z.string()).default([]),
  /** Why the file is not used (not JSON, not a hooks file), when it is there but unusable. */
  error: z.string().nullable()
})
export type HooksFileView = z.infer<typeof HooksFileViewSchema>

export const HookTrustEntrySchema = z.object({
  workspace: z.string(),
  decision: z.enum(['allow', 'deny'])
})
export type HookTrustEntry = z.infer<typeof HookTrustEntrySchema>

/** A hook that ran: what, where, and how it ended. */
export const HookRunLogEntrySchema = z.object({
  at: z.string(),
  event: z.string(),
  command: z.string(),
  source: z.enum(['user', 'workspace']),
  workspace: z.string(),
  runId: z.string(),
  code: z.number().nullable(),
  timedOut: z.boolean(),
  ms: z.number(),
  /** The start of stderr, when it failed or blocked. */
  stderr: z.string()
})
export type HookRunLogEntry = z.infer<typeof HookRunLogEntrySchema>

export const HooksOverviewSchema = z.object({
  user: HooksFileViewSchema,
  workspace: HooksFileViewSchema.nullable(),
  /** The decision on the workspace file as it is now; `changed` when one was made for an older copy. */
  workspaceDecision: z.enum(['allow', 'deny', 'changed', 'none']).nullable(),
  trust: z.array(HookTrustEntrySchema),
  runs: z.array(HookRunLogEntrySchema)
})
export type HooksOverview = z.infer<typeof HooksOverviewSchema>

export const HooksOverviewRequestSchema = z.object({ workspacePath: z.string().min(1).optional() })

/** Allow or deny the workspace's hooks file as it is now, or forget a remembered decision. */
export const HooksDecideRequestSchema = z.object({
  workspacePath: z.string().min(1),
  decision: z.enum(['allow', 'deny', 'forget'])
})

export const HooksForgetRequestSchema = z.object({ workspace: z.string().min(1) })

/** Open a hooks file in the editor, writing an empty one first when there is none. */
export const HooksOpenFileRequestSchema = z.object({
  scope: z.enum(['user', 'workspace']),
  workspacePath: z.string().min(1).optional()
})
