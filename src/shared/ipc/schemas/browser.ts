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
  canGoForward: z.boolean().optional(),
  /** True while the Browser tab is picking an element for the composer. */
  picking: z.boolean().optional(),
  /** When a click while picking added nothing (an element inside a frame); a new time each miss. */
  pickMissAt: z.number().optional()
})
export type AgentBrowserState = z.infer<typeof AgentBrowserStateSchema>

/** Caps on what a picked element carries: every string is page-supplied. */
export const BROWSER_PICK_LIMITS = {
  selector: 600,
  tag: 40,
  role: 40,
  name: 120,
  text: 240,
  url: 2048
} as const

/**
 * An element picked in the Browser tab, main → renderer and into the composer
 * chip. `bounds` is the element's rect in CSS px relative to the page's
 * viewport; `ref` is the `@eN` the last `browser_snapshot` gave the element.
 */
export const BrowserPickedElementSchema = z.object({
  selector: z.string().min(1).max(BROWSER_PICK_LIMITS.selector),
  tag: z
    .string()
    .max(BROWSER_PICK_LIMITS.tag)
    .regex(/^[a-z][a-z0-9-]*$/),
  role: z.string().max(BROWSER_PICK_LIMITS.role),
  name: z.string().max(BROWSER_PICK_LIMITS.name),
  text: z.string().max(BROWSER_PICK_LIMITS.text),
  url: z.string().max(BROWSER_PICK_LIMITS.url),
  bounds: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative()
  }),
  ref: z
    .string()
    .regex(/^e\d{1,6}$/)
    .optional()
})
export type BrowserPickedElement = z.infer<typeof BrowserPickedElementSchema>
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
  height: z.number().finite(),
  /**
   * A modal covers the panel. The native view paints above the page's DOM, so
   * it is hidden meanwhile — keeping its size, so the page does not re-layout.
   */
  occluded: z.boolean().optional()
})
export type BrowserSetBoundsRequest = z.infer<typeof BrowserSetBoundsRequestSchema>
