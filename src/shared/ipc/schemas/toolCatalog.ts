import { z } from 'zod'

/** Why a tool is not active in the next Agent-mode catalog. */
export const TOOL_CATALOG_REASONS = [
  'server-disabled',
  'auth-not-allowed',
  'denied-by-policy',
  'auto-mode-switch-off',
  'code-index-off'
] as const
export type ToolCatalogReason = (typeof TOOL_CATALOG_REASONS)[number]

const ToolCatalogEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** `agent` = written by a run with build_tool, living under userData. */
  source: z.enum(['builtin', 'mcp', 'agent']),
  /** Present for `source: 'mcp'` (the `mcp__<serverId>__<tool>` server id). */
  serverId: z.string().min(1).optional(),
  serverName: z.string().min(1).optional(),
  /**
   * MCP only: true when the server declared the tool read-only in its
   * `readOnlyHint` annotation, false when it declared otherwise or said
   * nothing. A claim, not a check — the agent's policy never trusts it — so
   * a UI must say "declares" rather than "is".
   */
  readOnlyHint: z.boolean().optional(),
  /** Modes whose mode policy admits this tool (computed with current settings). */
  modes: z.array(z.enum(['ask', 'plan', 'agent'])),
  /** True when the tool would appear in the next Agent-mode step catalog. */
  active: z.boolean(),
  reason: z.enum(TOOL_CATALOG_REASONS).optional()
})
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>

/** Omitted/null workspacePath = active workspace scope; a string scopes to that workspace. */
export const ToolCatalogRequestSchema = z.object({
  workspacePath: z.string().nullish()
})
export type ToolCatalogRequest = z.infer<typeof ToolCatalogRequestSchema>

export const ToolCatalogResultSchema = z.object({
  entries: z.array(ToolCatalogEntrySchema),
  /** Live per-server state for group headers in the UI. */
  servers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      enabled: z.boolean(),
      connected: z.boolean(),
      /**
       * How this server's schemas reach a run: `on-demand` means the agent
       * loads them with request_mcp_tools (or by calling one), `every-step`
       * means they ride in every request.
       */
      loading: z.enum(['on-demand', 'every-step'])
    })
  ),
  codeIndexEnabled: z.boolean(),
  autoModeSwitch: z.boolean(),
  /** Stable hash of entries + config; identical when nothing changed. */
  fingerprint: z.string()
})
export type ToolCatalogResult = z.infer<typeof ToolCatalogResultSchema>
