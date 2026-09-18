import { z } from 'zod'
import { RunIdSchema } from './agent'

export const BrowserWorkspaceScopeSchema = z.object({
  workspacePath: z.string().min(1).optional()
})
export type BrowserWorkspaceScope = z.infer<typeof BrowserWorkspaceScopeSchema>

export const AgentBrowserTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean()
})

export const AgentBrowserStateSchema = z.object({
  open: z.boolean(),
  url: z.string(),
  title: z.string(),
  snapshotDataUrl: z.string().nullable().optional(),
  navigating: z.boolean().optional(),
  agentBusy: z.boolean().optional(),
  userControl: z.boolean().optional(),
  /** True while the live view floats in the always-on-top PiP mini window. */
  pip: z.boolean().optional(),
  tabs: z.array(AgentBrowserTabSchema).optional(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional()
})
export type AgentBrowserState = z.infer<typeof AgentBrowserStateSchema>
export type AgentBrowserTab = z.infer<typeof AgentBrowserTabSchema>

/** Preload passes a bare string; object form includes optional workspace scope. */
export const BrowserNavigateRequestSchema = z
  .union([
    z.string().min(1),
    z.object({
      url: z.string().min(1),
      workspacePath: z.string().min(1).optional()
    })
  ])
  .transform((raw) =>
    typeof raw === 'string' ? { url: raw } : { url: raw.url, workspacePath: raw.workspacePath }
  )
export type BrowserNavigateRequest = z.infer<typeof BrowserNavigateRequestSchema>

export const BrowserTakeScreenshotRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema.optional(),
  tabId: z.string().min(1).optional()
})
export type BrowserTakeScreenshotRequest = z.infer<typeof BrowserTakeScreenshotRequestSchema>

export const BrowserSelectTabRequestSchema = z.object({
  tabId: z.string().min(1),
  workspacePath: z.string().min(1).optional()
})
export type BrowserSelectTabRequest = z.infer<typeof BrowserSelectTabRequestSchema>

export const BrowserOpenTabRequestSchema = z.object({
  url: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional()
})
export type BrowserOpenTabRequest = z.infer<typeof BrowserOpenTabRequestSchema>

export const BrowserCloseTabRequestSchema = z.object({
  tabId: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional()
})
export type BrowserCloseTabRequest = z.infer<typeof BrowserCloseTabRequestSchema>

export const BrowserClearBrowsingDataKindSchema = z.enum(['history', 'cookies', 'cache', 'all'])
export type BrowserClearBrowsingDataKind = z.infer<typeof BrowserClearBrowsingDataKindSchema>

export const BrowserClearBrowsingDataRequestSchema = z.object({
  kind: BrowserClearBrowsingDataKindSchema,
  workspacePath: z.string().min(1).optional()
})
export type BrowserClearBrowsingDataRequest = z.infer<typeof BrowserClearBrowsingDataRequestSchema>

/** null payload clears bounds; otherwise all four finite numbers are required. */
export const BrowserSetBoundsRequestSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite()
})
export type BrowserSetBoundsRequest = z.infer<typeof BrowserSetBoundsRequestSchema>
