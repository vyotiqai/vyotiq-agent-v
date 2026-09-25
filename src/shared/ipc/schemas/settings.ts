import { z } from 'zod'

/** Sub-agents a task may run at once: the default, and the most the setting allows. */
export const DEFAULT_MAX_PARALLEL_INSTANCES = 16
export const MAX_PARALLEL_INSTANCES_LIMIT = 16
import {
  DEFAULT_FONT_SCALE,
  DEFAULT_SKIN_ID,
  DEFAULT_UI_DENSITY,
  FontScaleSchema,
  SkinIdSchema,
  UiDensitySchema
} from '../../appearance'
import type { ThemeId } from '../../theme'
import {
  DEFAULT_THINKING_EFFORT,
  ProviderIdSchema,
  ServiceTierSchema,
  ThinkingEffortSchema,
  customProviderId,
  customProviderSlug,
  CustomProviderIdSchema,
  type ThinkingEffort
} from './providers'
import { DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO } from '../../domain/contextBudget'
import {
  CUSTOM_OPENAI_DEFAULT,
  normalizeCustomOpenAiBaseUrl
} from '../../domain/providers'
import {
  DEFAULT_MARKETPLACE_SETTINGS,
  MarketplaceSettingsSchema,
  McpAuthKindSchema,
  McpInputSchema,
  McpRuntimeRequirementSchema,
  McpTransportSchema
} from './marketplace'

export type { ThinkingEffort }

export const ThemeIdSchema = z.enum(['system', 'light', 'dark'])
export type { ThemeId } from '../../theme'

export {
  FontScaleSchema,
  SkinIdSchema,
  UiDensitySchema,
  type FontScale,
  type SkinId,
  type UiDensity
} from '../../appearance'

const McpServerIdSchema = z
  .string()
  .min(1)
  .refine((id) => !id.includes('__'), {
    message: 'MCP server id must not contain "__"'
  })

/**
 * MCP server config. Legacy entries without `transport` default to stdio.
 * stdio requires `command`; http/sse require `url`.
 */
export const McpServerSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const obj = { ...(raw as Record<string, unknown>) }
    if (obj.transport === undefined || obj.transport === null || obj.transport === '') {
      obj.transport = 'stdio'
    }
    return obj
  },
  z
    .object({
      id: McpServerIdSchema,
      name: z.string().min(1),
      transport: McpTransportSchema.default('stdio'),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      /**
       * When non-empty, only these bare MCP tool names are exposed/invokable.
       * Empty / omitted = all tools (minus deniedTools).
       */
      allowedTools: z.array(z.string().min(1)).optional(),
      /** Bare MCP tool names that are never exposed or invokable. */
      deniedTools: z.array(z.string().min(1)).optional(),
      /**
       * Put this server's tool schemas in every step's catalog instead of
       * waiting for `request_mcp_tools`. Off by default: a connected server
       * costs a line of names in the `<mcp_servers>` directory until the agent
       * asks for it. Turn on for a server the agent uses in nearly every run
       * and whose schemas are small.
       */
      autoLoad: z.boolean().optional(),
      enabled: z.boolean().default(true),
      source: z.enum(['manual', 'marketplace']).optional(),
      packageId: z.string().optional(),
      packageVersion: z.string().optional(),
      /** Non-secret OAuth client ID when the server does not use DCR. */
      oauthClientId: z.string().min(1).optional(),
      /**
       * Where stored OAuth/PAT credentials may be used.
       * `this-workspace` requires `authWorkspacePath` and never leaks to other workspaces.
       */
      authScope: z.enum(['all-workspaces', 'this-workspace']).optional(),
      authWorkspacePath: z.string().min(1).optional(),
      /** Google hosted MCP: readonly vs full documented MCP scopes. */
      googleAccess: z.enum(['read', 'read-write']).optional(),
      /**
       * Manifest-owned connect metadata, copied from `vyotiq.mcp.json` on every
       * marketplace sync (the manifest wins — these are not user-edited).
       * Absent for manually added servers, which is why `auth` is optional here
       * rather than defaulted; use `mcpSupportsOAuth` to read it.
       */
      auth: McpAuthKindSchema.optional(),
      requires: z.array(McpRuntimeRequirementSchema).optional(),
      inputs: z.array(McpInputSchema).optional(),
      setupUrl: z.string().optional(),
      /**
       * User-chosen absolute path to the stdio binary, set from the "Locate
       * binary" picker when the command is not on PATH. Survives manifest sync.
       */
      binaryPath: z.string().min(1).optional()
    })
    .superRefine((val, ctx) => {
      if (val.transport === 'stdio' && !(val.command ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'command is required for stdio transport',
          path: ['command']
        })
      }
      if ((val.transport === 'http' || val.transport === 'sse') && !(val.url ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'url is required for http/sse transport',
          path: ['url']
        })
      }
    })
)
export type McpServer = z.infer<typeof McpServerSchema>

const ThinkingPrefsSchema = z.object({
  thinkingEnabled: z.boolean(),
  thinkingEffort: ThinkingEffortSchema
})

/**
 * `mutating` gates only tools that change the workspace or run commands;
 * `all` gates every tool including reads. Default is `off` — approval is opt-in.
 */
export const ToolApprovalModeSchema = z.enum(['off', 'mutating', 'all'])
export type ToolApprovalMode = z.infer<typeof ToolApprovalModeSchema>

export const TerminalShellSchema = z.enum(['auto', 'cmd', 'powershell', 'bash'])
export type TerminalShell = z.infer<typeof TerminalShellSchema>

/** Composer interaction mode: Ask (read-only), Plan (plan artifacts), Agent (full). */
export const AgentInteractionModeSchema = z.enum(['ask', 'plan', 'agent'])
export type AgentInteractionMode = z.infer<typeof AgentInteractionModeSchema>

/** Default answer length for conversational replies. */
export const ResponseVerbositySchema = z.enum(['concise', 'balanced', 'detailed'])
export type ResponseVerbosity = z.infer<typeof ResponseVerbositySchema>

export const SearchEngineSchema = z.enum(['duckduckgo', 'bing', 'google'])
export type SearchEngineId = z.infer<typeof SearchEngineSchema>

export const OfflineWaitModeSchema = z.enum(['default', 'extended', 'wait_forever'])
export type OfflineWaitMode = z.infer<typeof OfflineWaitModeSchema>

/** Primary navigation layout: sessions/workspaces on Home, or the classic sidebar. */
export const NavigationModeSchema = z.enum(['home', 'sidebar'])
export type NavigationMode = z.infer<typeof NavigationModeSchema>
export const DEFAULT_NAVIGATION_MODE: NavigationMode = 'home'

/** User-global rules stored in settings (not workspace files). */
export const MAX_USER_RULES = 16
export const USER_RULE_NAME_MAX = 64
export const USER_RULE_BODY_MAX = 4000

export const UserRuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(USER_RULE_NAME_MAX),
  body: z.string().max(USER_RULE_BODY_MAX).default(''),
  enabled: z.boolean().default(true)
})
export type UserRule = z.infer<typeof UserRuleSchema>

export const AutonomousSkipQuestionsSchema = z.enum(['skip', 'wait'])
export type AutonomousSkipQuestions = z.infer<typeof AutonomousSkipQuestionsSchema>

export const DesktopNotificationModeSchema = z.enum(['off', 'unfocused', 'always'])
export type DesktopNotificationMode = z.infer<typeof DesktopNotificationModeSchema>

export const NotificationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  desktop: DesktopNotificationModeSchema.default('unfocused'),
  agentRunFinished: z.boolean().default(true),
  agentRunFailed: z.boolean().default(true),
  agentNeedsYou: z.boolean().default(true),
  system: z.boolean().default(true)
})
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  desktop: 'unfocused',
  agentRunFinished: true,
  agentRunFailed: true,
  agentNeedsYou: true,
  system: true
}

export const ToolApprovalSettingsSchema = z.object({
  mode: ToolApprovalModeSchema.default('off'),
  /** Tool names the user chose to always allow, persisted per workspace. */
  allowlist: z.array(z.string()).default([]),
  /**
   * When true, MCP server tools (`mcp__*`) require approval even if `mode` is off.
   * Built-in MCP meta tools (list/pin/release) follow `mode` only. Default on.
   */
  mcpProtection: z.boolean().default(true)
})
export type ToolApprovalSettings = z.infer<typeof ToolApprovalSettingsSchema>

export const DEFAULT_TOOL_APPROVAL: ToolApprovalSettings = {
  mode: 'off',
  allowlist: [],
  mcpProtection: true
}

export const CodeIndexSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Workspaces whose indexing is paused (Settings → Indexing → Pause): no sync
   * or embedding starts for them until resumed. What was indexed stays; a
   * resume carries on from there, since a sync skips unchanged files.
   */
  pausedPaths: z.array(z.string().min(1)).default([])
})
export type CodeIndexSettings = z.infer<typeof CodeIndexSettingsSchema>

export const DEFAULT_CODE_INDEX_SETTINGS: CodeIndexSettings = {
  enabled: true,
  pausedPaths: []
}

export const CodeIndexModelPhaseSchema = z.enum(['idle', 'ready', 'syncing', 'error'])
export type CodeIndexModelPhase = z.infer<typeof CodeIndexModelPhaseSchema>

export const CodeIndexSyncProgressSchema = z.object({
  stage: z.enum(['walking', 'scanning', 'reconciling', 'done']),
  filesDone: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  currentPath: z.string().nullable()
})
export type CodeIndexSyncProgress = z.infer<typeof CodeIndexSyncProgressSchema>

export const CodeIndexRuntimeStatusSchema = z.object({
  phase: CodeIndexModelPhaseSchema,
  /** 0–1 overall fraction for the active phase (index sync). */
  progress: z.number().nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  /** Live file counters while phase === 'syncing'. */
  indexProgress: CodeIndexSyncProgressSchema.nullable().default(null),
  /**
   * The workspace this phase belongs to. One status serves every workspace,
   * so without it a sync in one reads as building in all of them.
   */
  workspacePath: z.string().min(1).optional()
})
export type CodeIndexRuntimeStatus = z.infer<typeof CodeIndexRuntimeStatusSchema>

export const ProcessMetricsByTypeSchema = z.object({
  type: z.string(),
  count: z.number().int().nonnegative(),
  cpuPercent: z.number(),
  workingSetMb: z.number()
})

export const ProcessMetricsSnapshotSchema = z.object({
  at: z.string(),
  totalWorkingSetMb: z.number(),
  maxCpuPercent: z.number(),
  byType: z.array(ProcessMetricsByTypeSchema)
})
export type ProcessMetricsSnapshot = z.infer<typeof ProcessMetricsSnapshotSchema>

export const CodeIndexReindexRequestSchema = z.object({
  workspacePath: z.string().min(1).optional()
})
export type CodeIndexReindexRequest = z.infer<typeof CodeIndexReindexRequestSchema>

export const CodeIndexPauseRequestSchema = z.object({ workspacePath: z.string().min(1) })
export type CodeIndexPauseRequest = z.infer<typeof CodeIndexPauseRequestSchema>

export const DictationEngineSchema = z.enum(['openai', 'openrouter', 'local'])
export type DictationEngine = z.infer<typeof DictationEngineSchema>

export const DictationLocalModelIdSchema = z.enum(['whisper-tiny.en', 'whisper-small.en'])
export type DictationLocalModelId = z.infer<typeof DictationLocalModelIdSchema>

export const DictationWaveformStyleSchema = z.enum(['bars', 'dots', 'line', 'mirror'])
export type DictationWaveformStyle = z.infer<typeof DictationWaveformStyleSchema>

export const DictationSettingsSchema = z.object({
  /** Cloud vs on-device STT. Default keeps today's OpenAI path. */
  engine: DictationEngineSchema.default('openai'),
  /** Which installed local model to use. Empty until the user selects/installs. */
  localModelId: z.union([z.literal(''), DictationLocalModelIdSchema]).default(''),
  /** Composer listening visualizer. */
  waveformStyle: DictationWaveformStyleSchema.default('bars')
})
export type DictationSettings = z.infer<typeof DictationSettingsSchema>

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  engine: 'openai',
  localModelId: '',
  waveformStyle: 'bars'
}

export const DictationModelPhaseSchema = z.enum([
  'idle',
  'downloading',
  'loading',
  'ready',
  'error'
])
export type DictationModelPhase = z.infer<typeof DictationModelPhaseSchema>

export const DictationInstalledModelSchema = z.object({
  id: DictationLocalModelIdSchema,
  bytesOnDisk: z.number().int().nonnegative(),
  loaded: z.boolean()
})
export type DictationInstalledModel = z.infer<typeof DictationInstalledModelSchema>

export const DictationRuntimeStatusSchema = z.object({
  phase: DictationModelPhaseSchema,
  progress: z.number().nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  installed: z.array(DictationInstalledModelSchema),
  recommendedModelId: DictationLocalModelIdSchema,
  engine: DictationEngineSchema,
  /** Model currently downloading or loading, if any. */
  activeModelId: DictationLocalModelIdSchema.nullable(),
  loadedModelId: DictationLocalModelIdSchema.nullable()
})
export type DictationRuntimeStatus = z.infer<typeof DictationRuntimeStatusSchema>

export const DictationInstallRequestSchema = z.object({
  modelId: DictationLocalModelIdSchema
})
export type DictationInstallRequest = z.infer<typeof DictationInstallRequestSchema>

export const DictationDeleteCacheRequestSchema = z.object({
  modelId: DictationLocalModelIdSchema
})
export type DictationDeleteCacheRequest = z.infer<typeof DictationDeleteCacheRequestSchema>

/**
 * Storage retention policy (audit H4/H5). Defaults from the measured design
 * (remediation/12-storage-retention-design.md §6.4): keep-last-20 checkpoint
 * sessions with a 30-day backstop, orphans reaped after a 30-day grace,
 * session retention OFF by default, 5 GB managed-size backstop.
 */
export const StorageSettingsSchema = z.object({
  /** Kill switch — off means no checkpoint GC at all (keep everything forever). */
  checkpointGcEnabled: z.boolean().default(true),
  /** Keep the newest N checkpoint-bearing sessions per workspace (5–100). */
  checkpointKeepSessions: z.number().int().min(5).max(100).default(20),
  /** Age backstop in days — sessions with only older checkpoint data are pruned (7–365). */
  checkpointMaxAgeDays: z.number().int().min(7).max(365).default(30),
  /** Orphan storage-id reaper (untracked `workspaces/{id}` dirs, confirm-gated). */
  orphanReaperEnabled: z.boolean().default(true),
  /** Days an untracked storage dir must be idle before it is even reported as reapable. */
  orphanGraceDays: z.number().int().min(1).max(365).default(30),
  /** Removing a workspace also offers deletion of its storage dir (size shown). */
  pruneOnWorkspaceRemoval: z.boolean().default(true),
  /** Auto session retention OFF by default — "Clean now" applies it on demand. */
  sessionRetentionEnabled: z.boolean().default(false),
  /** Keep-last-N sessions per workspace when session retention runs (1–200). */
  sessionKeepCount: z.number().int().min(1).max(200).default(30),
  /** Age window in days for session retention (7–365). */
  sessionMaxAgeDays: z.number().int().min(7).max(365).default(60),
  /** Backstop over the managed userData surfaces (GB); LRU-evicts managed items only. */
  sizeCapGb: z.number().int().min(1).max(50).default(5)
})
export type StorageSettings = z.infer<typeof StorageSettingsSchema>

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  checkpointGcEnabled: true,
  checkpointKeepSessions: 20,
  checkpointMaxAgeDays: 30,
  orphanReaperEnabled: true,
  orphanGraceDays: 30,
  pruneOnWorkspaceRemoval: true,
  sessionRetentionEnabled: false,
  sessionKeepCount: 30,
  sessionMaxAgeDays: 60,
  sizeCapGb: 5
}

/** Current persisted settings format. Bump with a matching load-time rewrite. */
export const SETTINGS_FORMAT_VERSION = 6

/**
 * One user-defined OpenAI-compatible provider entry. `id` is a dynamic
 * `custom:<slug>` id (see CustomProviderIdSchema); `name` is the display
 * label; `baseUrl` must be an OpenAI-compatible base URL (normalized to end
 * with `/v1` by the domain helpers).
 */
export const CustomProviderSchema = z.object({
  id: CustomProviderIdSchema,
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1)
})
export type CustomProvider = z.infer<typeof CustomProviderSchema>

/** Slug of the entry seeded from the legacy single-provider field. */
export const DEFAULT_CUSTOM_PROVIDER_SLUG = 'default'
export const DEFAULT_CUSTOM_PROVIDER_ID = customProviderId(DEFAULT_CUSTOM_PROVIDER_SLUG)

/**
 * Dedupe custom provider rows: first entry wins per id slug AND per
 * normalized base URL (two ids pointing at one endpoint collapse to one),
 * invalid rows are dropped. Idempotent: the output of a call is stable under
 * a second call.
 */
export function normalizeCustomProviders(
  raw: ReadonlyArray<unknown> | undefined
): CustomProvider[] {
  if (!raw?.length) return []
  const out: CustomProvider[] = []
  const seenIds = new Set<string>()
  const seenBases = new Set<string>()
  for (const row of raw) {
    const parsed = CustomProviderSchema.safeParse(row)
    if (!parsed.success) continue
    const slug = customProviderSlug(parsed.data.id)
    if (!slug || seenIds.has(slug)) continue
    const base = normalizeCustomOpenAiBaseUrl(parsed.data.baseUrl)
    if (seenBases.has(base)) continue
    seenIds.add(slug)
    seenBases.add(base)
    out.push(parsed.data)
  }
  return out
}

/**
 * One-time legacy migration: seed a single `custom:default` entry from the
 * pre-multi-provider `customOpenAiBaseUrl` field when it differs from the
 * product default. A persisted list (even empty) prevents re-seeding, and the
 * legacy field is kept intact so nothing is lost on downgrade/rollback.
 */
export function seedCustomProvidersFromLegacy(
  raw: Record<string, unknown>
): { data: Record<string, unknown>; seeded: boolean } {
  if (Array.isArray(raw.customProviders)) {
    // A persisted list already exists (possibly seeded by an earlier load) —
    // never re-seed over it.
    return { data: raw, seeded: false }
  }
  const legacy =
    typeof raw.customOpenAiBaseUrl === 'string' ? raw.customOpenAiBaseUrl : undefined
  if (
    !legacy?.trim() ||
    normalizeCustomOpenAiBaseUrl(legacy) === normalizeCustomOpenAiBaseUrl(CUSTOM_OPENAI_DEFAULT)
  ) {
    return { data: raw, seeded: false }
  }
  const seeded = normalizeCustomProviders([
    { id: DEFAULT_CUSTOM_PROVIDER_ID, name: 'Custom', baseUrl: legacy.trim() }
  ])
  if (!seeded.length) return { data: raw, seeded: false }
  return { data: { ...raw, customProviders: seeded }, seeded: true }
}

export const SettingsSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  ollamaBaseUrl: z.string().min(1),
  /** OpenAI-compatible base URL for the `custom` provider (must end with `/v1`). */
  customOpenAiBaseUrl: z.string().min(1).default('http://127.0.0.1:8080/v1'),
  /**
   * User-defined OpenAI-compatible providers (`custom:<slug>` ids). Global;
   * deduped on load via normalizeCustomProviders, seeded once from the legacy
   * single-provider field by seedCustomProvidersFromLegacy.
   */
  customProviders: z.array(CustomProviderSchema).default([]),
  theme: ThemeIdSchema,
  navigationMode: NavigationModeSchema.default(DEFAULT_NAVIGATION_MODE),
  fontScale: FontScaleSchema.default(DEFAULT_FONT_SCALE),
  uiDensity: UiDensitySchema.default(DEFAULT_UI_DENSITY),
  skinId: SkinIdSchema.catch(DEFAULT_SKIN_ID).default(DEFAULT_SKIN_ID),
  /** Local user CSS overlay path. Empty = none. */
  customCssPath: z.string().default(''),
  telemetryEnabled: z.boolean().default(false),
  mcpServers: z.array(McpServerSchema).default([]),
  /**
   * How connected MCP tool schemas reach the model.
   * `on-demand` (default): held back until the agent loads them with
   * `request_mcp_tools` (or calls one, which loads it), so an install the run
   * never touches costs nothing but its names. `eager`: the earlier behaviour —
   * every connected tool in every step, measured at 67k tokens on a four-server
   * install. Per-server `autoLoad` overrides `on-demand` for that server.
   */
  mcpToolLoading: z.enum(['on-demand', 'eager']).default('on-demand'),
  keepRecentTurns: z.number().int().min(4).max(50).default(12),
  autoCompactThresholdRatio: z
    .number()
    .min(0.05)
    .max(0.95)
    .default(DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO),
  /**
   * Persisted settings format. Not a UI setting. Bump when rewriting an old
   * product default that was already written into settings.json.
   */
  settingsVersion: z.number().int().min(0).default(SETTINGS_FORMAT_VERSION),
  thinkingEnabled: z.boolean().default(true),
  thinkingEffort: ThinkingEffortSchema.default(DEFAULT_THINKING_EFFORT),
  showThinking: z.boolean().default(true),
  favoriteModels: z.array(z.string()).default([]),
  /** Session keys (`${workspacePath}␀${runId}`) pinned above the Home recency list. */
  pinnedRuns: z.array(z.string()).max(24).default([]),
  recentModels: z.array(z.string()).max(5).default([]),
  thinkingPrefsByProvider: z.record(ProviderIdSchema, ThinkingPrefsSchema).default({}),
  serviceTierByModel: z.record(z.string(), ServiceTierSchema).default({}),
  serviceTier: ServiceTierSchema.default('default'),
  toolApproval: ToolApprovalSettingsSchema.default(DEFAULT_TOOL_APPROVAL),
  /** Default search engine for browser_search. */
  searchEngine: SearchEngineSchema.default('duckduckgo'),
  /**
   * When non-empty, agent browser navigation is limited to these hostnames
   * (exact or `*.suffix` wildcards). Empty = no extra host filter (SSRF rules still apply).
   */
  browserDomainAllowlist: z.array(z.string().min(1)).default([]),
  /** Set after first-send tool approval onboarding modal is shown or dismissed. */
  toolApprovalOnboardingDone: z.boolean().default(false),
  /** Shell used by the terminal tool. `auto` prefers PowerShell on Windows when available. */
  terminalShell: TerminalShellSchema.default('auto'),
  /**
   * Terminal screen-reader mode. `auto` follows OS assistive-tech detection
   * (Chromium reports it via accessibility-support-changed); `on`/`off` force
   * it. xterm screenReaderMode maintains a parallel DOM per write, so forcing
   * it on without a screen reader costs significant CPU on chatty output.
   */
  terminalScreenReader: z.enum(['auto', 'on', 'off']).default('auto'),
  /**
   * Optional override for the diagnostics tool typecheck command.
   * Empty = auto-detect from package.json scripts / tsc.
   */
  diagnosticsCommand: z.string().default(''),
  /**
   * When true, the agent may call `switch_mode` mid-run as the task phase changes.
   * When false, only the user changes mode (composer picker or slash). Default on.
   * Live runs re-read this at each step boundary (next step picks up a toggle).
   */
  autoModeSwitch: z.boolean().default(true),
  /**
   * When true, opening an interrupted chat resumes automatically instead of showing Continue.
   */
  autoResumeInterruptedRuns: z.boolean().default(true),
  /**
   * Sub-agents (inline instances) one task may run at the same time. A spawn
   * past it is refused and the agent is told to await one first. The default
   * is above what a task uses in practice, so it changes nothing until lowered.
   */
  maxParallelInstances: z.number().int().min(1).max(MAX_PARALLEL_INSTANCES_LIMIT).default(DEFAULT_MAX_PARALLEL_INSTANCES),
  /**
   * Maximum simultaneously visible chat panes (split session view). 0 = Auto:
   * derived from the viewport (min 280px per pane, hard cap 6). 1–6 is a fixed
   * limit that may exceed what fits — the pane row scrolls horizontally.
   */
  maxChatPanes: z.number().int().min(0).max(6).default(0),
  /** Packaged builds check for app updates at launch and every 6 hours. */
  autoCheckUpdates: z.boolean().default(true),
  /**
   * Shared Google Cloud OAuth client ID for Gmail/Drive/Calendar MCP.
   * Non-secret. Client secret lives in OS secure storage, never settings.json.
   */
  googleMcpClientId: z.string().default(''),
  marketplace: MarketplaceSettingsSchema.default(DEFAULT_MARKETPLACE_SETTINGS),
  /** Local codebase semantic index (codebase_search). */
  codeIndex: CodeIndexSettingsSchema.default(DEFAULT_CODE_INDEX_SETTINGS),
  /** Composer dictation engine + which local Whisper weights to use. */
  dictation: DictationSettingsSchema.default(DEFAULT_DICTATION_SETTINGS),
  /**
   * Unattended runs: auto-approve gated tools (high-risk still gated). Off by
   * default.
   */
  autonomousMode: z.boolean().default(false),
  /**
   * When autonomousMode is on: skip ask_question immediately, or wait for answers
   * until the normal 15-minute question timeout.
   */
  autonomousSkipQuestions: AutonomousSkipQuestionsSchema.default('wait'),
  /** Storage retention policy (checkpoint GC, orphan reaper, size cap). */
  storage: StorageSettingsSchema.default(DEFAULT_STORAGE_SETTINGS),
  /**
   * One-time ack for the §8.1 first-run suspension: until the user has opened
   * Settings → Storage once, only the free resolved/undone checkpoint pass runs
   * automatically — everything else waits for this ack.
   */
  storageSurfaceAcked: z.boolean().default(false),
  /**
   * Retired: offline waits are unlimited now (resolveOfflineWaitMs ignores
   * this), so Settings no longer shows it. Kept so settings.json files that
   * carry it still parse.
   */
  offlineWaitMode: OfflineWaitModeSchema.default('default'),
  /**
   * User-global rules injected as `<user_rules>` on every agent step.
   * Disabled rules are omitted. Workspace rules override these on conflict.
   */
  userRules: z.array(UserRuleSchema).max(MAX_USER_RULES).default([]),
  /** Optional assistant name surfaced in the stable prompt zone. Empty = unnamed. */
  agentPersona: z.string().max(1000).default(''),
  /** Optional tone directive for replies. Empty = no tone directive. */
  agentTone: z.string().max(2000).default(''),
  /** Optional identity blurb for replies. Empty = no identity. */
  agentIdentity: z.string().max(1000).default(''),
  /** Preferred response language. Empty = follow the user's language. */
  responseLanguage: z.string().max(64).default(''),
  /** Default answer length for conversational replies. */
  responseVerbosity: ResponseVerbositySchema.default('concise'),
  /**
   * App-wide inbox + OS toast preferences. Not a workspace override.
   */
  notifications: NotificationSettingsSchema.default(DEFAULT_NOTIFICATION_SETTINGS)
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  model: 'qwen2.5',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1',
  customProviders: [],
  theme: 'system',
  navigationMode: DEFAULT_NAVIGATION_MODE,
  fontScale: DEFAULT_FONT_SCALE,
  uiDensity: DEFAULT_UI_DENSITY,
  skinId: DEFAULT_SKIN_ID,
  customCssPath: '',
  telemetryEnabled: false,
  mcpServers: [],
  mcpToolLoading: 'on-demand',
  keepRecentTurns: 12,
  autoCompactThresholdRatio: DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  settingsVersion: SETTINGS_FORMAT_VERSION,
  thinkingEnabled: true,
  thinkingEffort: DEFAULT_THINKING_EFFORT,
  showThinking: true,
  favoriteModels: [],
  pinnedRuns: [],
  recentModels: [],
  thinkingPrefsByProvider: {},
  serviceTierByModel: {},
  serviceTier: 'default',
  toolApproval: DEFAULT_TOOL_APPROVAL,
  searchEngine: 'duckduckgo',
  browserDomainAllowlist: [],
  toolApprovalOnboardingDone: false,
  terminalShell: 'auto',
  terminalScreenReader: 'auto',
  diagnosticsCommand: '',
  autoModeSwitch: true,
  autoResumeInterruptedRuns: true,
  maxParallelInstances: DEFAULT_MAX_PARALLEL_INSTANCES,
  maxChatPanes: 0,
  autoCheckUpdates: true,
  googleMcpClientId: '',
  marketplace: DEFAULT_MARKETPLACE_SETTINGS,
  codeIndex: DEFAULT_CODE_INDEX_SETTINGS,
  dictation: DEFAULT_DICTATION_SETTINGS,
  autonomousMode: false,
  autonomousSkipQuestions: 'wait',
  storage: DEFAULT_STORAGE_SETTINGS,
  storageSurfaceAcked: false,
  offlineWaitMode: 'default',
  userRules: [],
  agentPersona: '',
  agentTone: '',
  agentIdentity: '',
  responseLanguage: '',
  responseVerbosity: 'concise',
  notifications: DEFAULT_NOTIFICATION_SETTINGS
}

export const SetSettingsRequestSchema = SettingsSchema.partial()
export type SetSettingsRequest = z.infer<typeof SetSettingsRequestSchema>

export const WindowMaximizedChangedSchema = z.boolean()

export const TelemetryStatusSchema = z.object({
  dsnConfigured: z.boolean(),
  telemetryEnabled: z.boolean()
})
export type TelemetryStatus = z.infer<typeof TelemetryStatusSchema>

export const TraceStartResultSchema = z.object({
  categoryFilter: z.string(),
  traceOptions: z.string()
})
export type TraceStartResult = z.infer<typeof TraceStartResultSchema>

export const TraceStatusResultSchema = z.object({
  recording: z.boolean(),
  startedAt: z.string().nullable(),
  bufferPercent: z.number().nullable()
})
export type TraceStatusResult = z.infer<typeof TraceStatusResultSchema>

export const TraceStopResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative()
})
export type TraceStopResult = z.infer<typeof TraceStopResultSchema>

export const AppInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  homepage: z
    .string()
    .url()
    .refine((url) => url.startsWith('https:'), { message: 'homepage must be https' }),
  electron: z.string().min(1),
  chrome: z.string().min(1),
  node: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  osVersion: z.string().min(1)
})
export type AppInfo = z.infer<typeof AppInfoSchema>

export const CrashSnippetSchema = z.object({
  at: z.string().min(1),
  kind: z.enum(['renderer', 'child']),
  reason: z.string().min(1),
  exitCode: z.number().int().optional(),
  exitCodeHex: z.string().optional(),
  processType: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  crashDumpCount: z.number().int().min(0).optional()
})
export type CrashSnippet = z.infer<typeof CrashSnippetSchema>

export const CrashRecoveryPendingSchema = z.object({
  at: z.string().min(1),
  reason: z.string().min(1),
  exitCode: z.number().int().optional(),
  exitCodeHex: z.string().optional()
})
export type CrashRecoveryPending = z.infer<typeof CrashRecoveryPendingSchema>

export const CrashDiagnosticsSnapshotSchema = z.object({
  snippets: z.array(CrashSnippetSchema),
  pendingRecovery: CrashRecoveryPendingSchema.nullable()
})
export type CrashDiagnosticsSnapshot = z.infer<typeof CrashDiagnosticsSnapshotSchema>

export function parseSettings(data: unknown): Settings {
  return SettingsSchema.parse(data)
}
