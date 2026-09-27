import { z } from 'zod'

export const GithubAuthStatusSchema = z.object({
  ghAvailable: z.boolean(),
  ghAuthenticated: z.boolean(),
  hasAppToken: z.boolean(),
  pending: z.boolean(),
  userCode: z.string().nullable(),
  verificationUri: z.string().nullable(),
  error: z.string().nullable()
})
export type GithubAuthStatus = z.infer<typeof GithubAuthStatusSchema>

/**
 * `fresh`: GitHub rejected the saved sign-in (a revoked or expired token), so
 * skip it and the CLI's copy and run the device flow for a new one.
 */
export const GithubAuthStartRequestSchema = z
  .object({ fresh: z.boolean().optional() })
  .strict()
  .optional()
export type GithubAuthStartRequest = z.infer<typeof GithubAuthStartRequestSchema>

export const GithubCliInstallResultSchema = z.object({
  installed: z.boolean(),
  detail: z.string(),
  ghAvailable: z.boolean()
})
export type GithubCliInstallResult = z.infer<typeof GithubCliInstallResultSchema>

export const ShellOpenExternalRequestSchema = z.object({
  url: z.string().min(1).max(2048)
})
