import { z } from 'zod'

import { RunIdSchema } from './agent'

/** The longest brief a `vyotiq://new` link may carry. */
export const DEEP_LINK_BRIEF_MAX = 20_000

/** What a link or the command line asks the app to open. */
export const DeepLinkTargetSchema = z.discriminatedUnion('type', [
  /** `vyotiq://run/<runId>?ws=…`: a task in a workspace. */
  z.object({
    type: z.literal('open_run'),
    /** Canonical workspace path. Null means "resolve from currently open workspaces". */
    workspacePath: z.string().min(1).nullable(),
    runId: RunIdSchema
  }),
  /** `vyotiq://open?ws=…`, or a folder named on the command line. */
  z.object({
    type: z.literal('open_workspace'),
    workspacePath: z.string().min(1),
    /** Named on the command line (or dropped on the Dock icon): the person chose it, so it opens without asking. */
    fromCommandLine: z.boolean()
  }),
  /** `vyotiq://new?ws=…&brief=…`: New task with the brief filled in. It is never sent on its own. */
  z.object({
    type: z.literal('new_task'),
    /** Null means the workspace in front. */
    workspacePath: z.string().min(1).nullable(),
    brief: z.string().max(DEEP_LINK_BRIEF_MAX)
  })
])

export type DeepLinkTarget = z.infer<typeof DeepLinkTargetSchema>

/**
 * Payload pushed on `deeplink:opened` / returned by `deeplink:consume`.
 * `target: null` marks a URL that was recognized as vyotiq:// but not understood.
 */
export const DeepLinkPayloadSchema = z.object({
  rawUrl: z.string().min(1).max(4096),
  target: DeepLinkTargetSchema.nullable()
})

export type DeepLinkPayload = z.infer<typeof DeepLinkPayloadSchema>
