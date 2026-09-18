import { z } from 'zod'

import { RunIdSchema } from './agent'

/** v1 target: open a run (chat) in a workspace. */
export const DeepLinkTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open_run'),
    /** Canonical workspace path. Null means "resolve from currently open workspaces". */
    workspacePath: z.string().min(1).nullable(),
    runId: RunIdSchema
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
