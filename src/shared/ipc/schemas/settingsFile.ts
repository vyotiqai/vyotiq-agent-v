import { z } from 'zod'

/** One field an import would change, with its value now and in the file. */
export const SettingsImportChangeSchema = z.object({
  key: z.string(),
  from: z.unknown(),
  to: z.unknown()
})
export type SettingsImportChange = z.infer<typeof SettingsImportChangeSchema>

export const SettingsImportPreviewSchema = z.object({
  changes: z.array(SettingsImportChangeSchema),
  /** Fields in the file that won't be applied, and why. */
  skipped: z.array(z.object({ key: z.string(), reason: z.string() }))
})
export type SettingsImportPreview = z.infer<typeof SettingsImportPreviewSchema>

/** What choosing a file found; `token` applies exactly this preview. */
export type SettingsImportPreviewResult =
  | { picked: false }
  | ({ picked: true; token: string; path: string } & SettingsImportPreview)

export const SettingsImportApplyRequestSchema = z.object({ token: z.string().min(1).max(100) })

export type SettingsExportResult = { saved: false } | { saved: true; path: string }
