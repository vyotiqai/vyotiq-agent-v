import { z } from 'zod'

export const NOTIFICATION_TITLE_MAX = 80
export const NOTIFICATION_BODY_MAX = 200
export const NOTIFICATION_INBOX_CAP = 50

export const NotificationSourceSchema = z.enum(['agent', 'system'])
export type NotificationSource = z.infer<typeof NotificationSourceSchema>

export const NotificationKindSchema = z.enum(['run_done', 'run_error', 'needs_you', 'crash', 'update_ready'])
export type NotificationKind = z.infer<typeof NotificationKindSchema>

export const NotificationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open_run'),
    workspacePath: z.string().min(1),
    runId: z.string().min(1)
  }),
  z.object({
    type: z.literal('open_settings'),
    /**
     * Only crash alerts open Settings, and the crash list lives in
     * Diagnostics. Items written before that section existed say 'general'
     * and sit in the persisted inbox, so the old value is folded forward
     * instead of failing the parse and dropping the item.
     */
    section: z.preprocess(
      (value) => (value === 'general' ? 'diagnostics' : value),
      z.literal('diagnostics')
    )
  }),
  /** Open the navigator's update panel — the one update surface. */
  z.object({ type: z.literal('open_update') })
])
export type NotificationAction = z.infer<typeof NotificationActionSchema>

export const NotificationItemSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  read: z.boolean(),
  source: NotificationSourceSchema,
  kind: NotificationKindSchema,
  title: z.string().min(1).max(NOTIFICATION_TITLE_MAX),
  body: z.string().max(NOTIFICATION_BODY_MAX),
  dedupeKey: z.string().min(1),
  action: NotificationActionSchema.optional(),
  /** A finished run's files still waiting on Keep or Undo when it finished — its Ready for review. */
  reviewFiles: z.number().int().min(1).optional()
})
export type NotificationItem = z.infer<typeof NotificationItemSchema>

export const NotificationListSchema = z.object({
  items: z.array(NotificationItemSchema).max(NOTIFICATION_INBOX_CAP)
})
export type NotificationList = z.infer<typeof NotificationListSchema>

export const NotificationMutateRequestSchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ all: z.literal(true) })
])
export type NotificationMutateRequest = z.infer<typeof NotificationMutateRequestSchema>

export const NotificationPublishInputSchema = z.object({
  source: NotificationSourceSchema,
  kind: NotificationKindSchema,
  title: z.string().min(1),
  body: z.string(),
  dedupeKey: z.string().min(1),
  action: NotificationActionSchema.optional(),
  reviewFiles: z.number().int().min(1).optional()
})
export type NotificationPublishInput = z.infer<typeof NotificationPublishInputSchema>

export const NotificationStoreFileSchema = z.object({
  items: z.array(z.unknown())
})

export function needsYouDedupeKey(runId: string): string {
  return `needs_you:${runId}`
}

export function runDoneDedupeKey(runId: string): string {
  return `run:${runId}:done`
}

export function runErrorDedupeKey(runId: string): string {
  return `run:${runId}:error`
}

export const CRASH_DEDUPE_KEY = 'crash'

/**
 * One "update ready" item at most: a newer download replaces it, and it goes at
 * the next launch — a restart ends that download's ready state either way.
 */
export const UPDATE_READY_DEDUPE_KEY = 'update_ready'
