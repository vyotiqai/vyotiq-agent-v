import { z } from 'zod'

/** Updater state machine statuses pushed to the renderer on `updater:state`. */
export const UpdaterStateSchema = z.enum([
  'idle',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'error'
])
export type UpdaterState = z.infer<typeof UpdaterStateSchema>

/** One `## Heading` group with its `- ` bullet lines from the release notes. */
export const ReleaseNotesSectionSchema = z.object({
  heading: z.string(),
  items: z.array(z.string())
})
export type ReleaseNotesSection = z.infer<typeof ReleaseNotesSectionSchema>

/** Structured release metadata (exact contract shape). */
export const UpdateInfoSchema = z.object({
  version: z.string(),
  releaseDate: z.string(),
  releaseName: z.string(),
  notesText: z.string(),
  notesSections: z.array(ReleaseNotesSectionSchema)
})
export type UpdateInfo = z.infer<typeof UpdateInfoSchema>

export const UpdateProgressSchema = z.object({
  percent: z.number(),
  transferred: z.number(),
  total: z.number()
})
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>

/** Payload pushed on the `updater:state` channel. */
export const UpdaterStatePayloadSchema = z.object({
  status: UpdaterStateSchema,
  info: UpdateInfoSchema.optional(),
  progress: UpdateProgressSchema.optional(),
  error: z.string().optional()
})
export type UpdaterStatePayload = z.infer<typeof UpdaterStatePayloadSchema>

export const UpdaterCheckRequestSchema = z.object({})
export type UpdaterCheckRequest = z.infer<typeof UpdaterCheckRequestSchema>

export const UpdaterDownloadRequestSchema = z.object({})
export type UpdaterDownloadRequest = z.infer<typeof UpdaterDownloadRequestSchema>

export const UpdaterInstallRequestSchema = z.object({})
export type UpdaterInstallRequest = z.infer<typeof UpdaterInstallRequestSchema>
