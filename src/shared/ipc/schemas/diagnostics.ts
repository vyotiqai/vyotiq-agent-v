import { z } from 'zod'

/** `diagnostics:export` takes no options; an empty object keeps the door shut to anything else. */
export const DiagnosticsExportRequestSchema = z.object({}).strict()
export type DiagnosticsExportRequest = z.infer<typeof DiagnosticsExportRequestSchema>

/**
 * What the export did. `fileName` is the saved file's name only: the folder is
 * the person's own pick and its path would carry their username.
 */
export type DiagnosticsExportResult =
  | { saved: false }
  | { saved: true; fileName: string; bytes: number; files: string[] }
