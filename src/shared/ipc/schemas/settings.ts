import { z } from 'zod'

/** Sub-agents a task may run at once: the default, and the most the setting allows. */
export const DEFAULT_MAX_PARALLEL_INSTANCES = 16
export const MAX_PARALLEL_INSTANCES_LIMIT = 16
/** Upper bound for Settings → Agent → Spend limit per task, in dollars. */
export const TASK_SPEND_LIMIT_MAX_USD = 10_000
import {
  AnnounceVerbositySchema,
  ContrastSchema,
  DEFAULT_ALWAYS_SHOW_FOCUS_RING,
  DEFAULT_ANNOUNCE_VERBOSITY,
  DEFAULT_CONTRAST,
  DEFAULT_FONT_SCALE,
  DEFAULT_REDUCE_MOTION,
  DEFAULT_SKIN_ID,
  FontScaleSchema,
  ReduceMotionSchema,
  SkinIdSchema
} from '../../appearance'
import type { ThemeId } from '../../theme'
import {
  DEFAULT_THINKING_EFFORT,
  ProviderIdSchemaAny,
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
  customEndpointBaseUrl,
  normalizeCustomOpenAiBaseUrl
} from '../../domain/providers'
import { sanitizeCustomHeaders } from '../../domain/network'
import {
  BEDROCK_DEFAULT_REGION,
  BEDROCK_REGION_RE,
  VERTEX_DEFAULT_LOCATION,
  VERTEX_LOCATION_RE,
  VERTEX_PROJECT_RE
} from '../../domain/cloudProviders'
import {
  DEFAULT_MARKETPLACE_SETTINGS,
  MarketplaceSettingsSchema,
  McpAuthKindSchema,
  McpInputSchema,
  McpRuntimeRequirementSchema,
  McpTransportSchema
} from './marketplace'
import { DEFAULT_VOICE_SETTINGS, VoiceSettingsSchema } from './voice'

export type { ThinkingEffort }

export const ThemeIdSchema = z.enum(['system', 'light', 'dark'])
export type { ThemeId } from '../../theme'

export { FontScaleSchema, SkinIdSchema, type FontScale, type SkinId } from '../../appearance'
export {
  ReduceMotionSchema,
  ContrastSchema,
  AnnounceVerbositySchema,
  type ReduceMotion,
  type Contrast,
  type AnnounceVerbosity
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

/** Composer interaction mode: Ask (read-only) or Agent (full). */
export const AGENT_INTERACTION_MODES = ['ask', 'agent'] as const

/**
 * Plan was merged into Agent — every capability Plan gated (plan artifacts,
 * `create_plan`, todos, diagnostics) is now reachable from Agent, so the mode
 * that only restricted them has nothing left to do.
 *
 * `'plan'` is still ACCEPTED here and folded to `'agent'`, because the value is
 * durable: it sits in `workspaces.json` (`uiStateByPath.*.agentMode`), in every
 * `status.json` a Plan run wrote, and in `mode_changed` rows of `events.jsonl`.
 * A bare `z.enum(['ask','agent'])` would reject those: `readStatus` treats a
 * schema failure as a CORRUPT file and returns null, so a finished Plan run
 * would lose its status entirely. Folding migrates them on next read/write
 * instead. Do not narrow this to a plain enum while old stores can exist.
 */
export const AgentInteractionModeSchema = z.preprocess(
  (value) => (value === 'plan' ? 'agent' : value),
  z.enum(AGENT_INTERACTION_MODES)
)
export type AgentInteractionMode = (typeof AGENT_INTERACTION_MODES)[number]

/** Default answer length for conversational replies. */
export const ResponseVerbositySchema = z.enum(['concise', 'balanced', 'detailed'])
export type ResponseVerbosity = z.infer<typeof ResponseVerbositySchema>

export const SearchEngineSchema = z.enum(['duckduckgo', 'bing', 'google'])
export type SearchEngineId = z.infer<typeof SearchEngineSchema>


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

/** `HH:MM`, 24-hour, local time. */
const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/**
 * Hours when desktop notifications stay quiet (the inbox still fills). The
 * window may wrap midnight: 22:00 to 07:00.
 */
export const QuietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  start: ClockTimeSchema.catch('22:00').default('22:00'),
  end: ClockTimeSchema.catch('07:00').default('07:00')
})
export type QuietHours = z.infer<typeof QuietHoursSchema>

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: '22:00', end: '07:00' }

/** Where notifications go off this computer: an ntfy topic, a webhook, or nowhere. */
export const RemoteNotificationModeSchema = z.enum(['off', 'ntfy', 'webhook'])
export type RemoteNotificationMode = z.infer<typeof RemoteNotificationModeSchema>

export const NotificationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  desktop: DesktopNotificationModeSchema.default('unfocused'),
  agentRunFinished: z.boolean().default(true),
  agentRunFailed: z.boolean().default(true),
  agentNeedsYou: z.boolean().default(true),
  system: z.boolean().default(true),
  /** Desktop notifications play the system sound. */
  sound: z.boolean().catch(false).default(false),
  quietHours: QuietHoursSchema.catch(DEFAULT_QUIET_HOURS).default(DEFAULT_QUIET_HOURS),
  /** Also send to a phone; the URL is in the key vault (tool key `notify`). */
  remote: RemoteNotificationModeSchema.catch('off').default('off'),
  /** `away`: only while the window is unfocused, minimized or in the tray. */
  remoteWhen: z.enum(['away', 'always']).catch('away').default('away')
})
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>

/**
 * How main-process traffic (providers, MCP, updates, downloads) reaches the
 * internet. `system` follows HTTPS_PROXY/NO_PROXY when set, else the OS proxy;
 * `manual` uses `proxyUrl` for everything but `proxyBypass`; `direct` uses none.
 */
export const ProxyModeSchema = z.enum(['system', 'manual', 'direct'])
export type ProxyMode = z.infer<typeof ProxyModeSchema>

export const NetworkSettingsSchema = z.object({
  proxyMode: ProxyModeSchema.catch('system').default('system'),
  /** `http(s)://host:port`, no credentials (see validateProxyUrl). */
  proxyUrl: z.string().trim().max(500).catch('').default(''),
  /** Hosts that skip the manual proxy, comma-separated (`localhost, *.corp`). */
  proxyBypass: z.string().trim().max(2000).catch('').default(''),
  /** The manual proxy's user name; its password is in the key vault (tool key `proxy`). */
  proxyUsername: z.string().trim().max(200).catch('').default('')
})
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>

/** A key chord the user bound a shortcut to (Settings → Shortcuts). */
export const ShortcutChordSchema = z.object({
  key: z.string().min(1).max(12),
  mod: z.boolean(),
  shift: z.enum(['forbid', 'allow', 'require']).optional(),
  alt: z.boolean().optional()
})
export type ShortcutChordSetting = z.infer<typeof ShortcutChordSchema>

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyMode: 'system',
  proxyUrl: '',
  proxyBypass: '',
  proxyUsername: ''
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  desktop: 'unfocused',
  agentRunFinished: true,
  agentRunFailed: true,
  agentNeedsYou: true,
  system: true,
  sound: false,
  quietHours: DEFAULT_QUIET_HOURS,
  remote: 'off',
  remoteWhen: 'away'
}

/** Minutes since midnight for `HH:MM`; NaN when unreadable. */
function clockMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN
}

/** Whether `now` (local time) falls inside quiet hours; a window may wrap midnight. */
export function inQuietHours(quiet: QuietHours | undefined, now: Date): boolean {
  if (!quiet?.enabled) return false
  const start = clockMinutes(quiet.start)
  const end = clockMinutes(quiet.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
  const minute = now.getHours() * 60 + now.getMinutes()
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** What a permission rule does to a call it matches. Precedence: deny > ask > allow. */
export const PermissionRuleEffectSchema = z.enum(['allow', 'ask', 'deny'])
export type PermissionRuleEffect = z.infer<typeof PermissionRuleEffectSchema>

/**
 * One permission rule (Settings → Agent → Permission rules, or a workspace's
 * `.vyotiq/permissions.json`). Every matcher it sets must match:
 *
 * - `tool`: the tool's name; `*` is a wildcard (`mcp__github__*`).
 * - `command`: a terminal command prefix, word for word (`git push`). A deny or
 *   ask matches the prefix anywhere in a chain; an allow only a simple command.
 * - `path`: a glob (`**`, `*`, `?`, `{a,b}`). Workspace-relative, absolute, or
 *   from `~/`; one with no `/` matches that name at any depth, and a match on
 *   a folder covers everything in it.
 */
export const PermissionRuleSchema = z
  .object({
    effect: PermissionRuleEffectSchema,
    tool: z.string().trim().min(1).max(200).optional(),
    command: z.string().trim().min(1).max(500).optional(),
    path: z.string().trim().min(1).max(500).optional()
  })
  .refine((rule) => Boolean(rule.tool || rule.command || rule.path), {
    message: 'A permission rule needs a tool, a command or a path'
  })
export type PermissionRule = z.infer<typeof PermissionRuleSchema>

/**
 * A list of rules that drops the entries it cannot read rather than failing:
 * one hand-edited typo must not quarantine the whole settings file.
 */
export const PermissionRulesSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = PermissionRuleSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
)

export const ToolApprovalSettingsSchema = z.object({
  /**
   * Edits and commands ask, the mode Set up recommends. Until 1.3 the default
   * was `off`, so Reset section, a new workspace override or a rebuilt
   * settings file silently turned every approval off.
   */
  mode: ToolApprovalModeSchema.default('mutating'),
  /** Tool names the user chose to always allow, persisted per workspace. */
  allowlist: z.array(z.string()).default([]),
  /**
   * When true, MCP server tools (`mcp__*`) require approval even if `mode` is off.
   * Built-in MCP meta tools (list/pin/release) follow `mode` only. Default on.
   */
  mcpProtection: z.boolean().default(true),
  /** Permission rules, checked before the mode and the allowlist (deny > ask > allow). */
  rules: PermissionRulesSchema.default([])
})
export type ToolApprovalSettings = z.infer<typeof ToolApprovalSettingsSchema>

export const DEFAULT_TOOL_APPROVAL: ToolApprovalSettings = {
  mode: 'mutating',
  allowlist: [],
  mcpProtection: true,
  rules: []
}

/**
 * OS-level confinement for commands the agent runs (terminal, run_tests,
 * diagnostics). `workspace-write` lets a command read the disk but write only
 * the workspace, temp and package caches (main/agent/sandbox). Off by default.
 */
export const AgentSandboxModeSchema = z.enum(['off', 'workspace-write'])
export type AgentSandboxMode = z.infer<typeof AgentSandboxModeSchema>

export const AgentSandboxNetworkSchema = z.enum(['allow', 'deny'])
export type AgentSandboxNetwork = z.infer<typeof AgentSandboxNetworkSchema>

export const AgentSandboxSettingsSchema = z.object({
  mode: AgentSandboxModeSchema.catch('off').default('off'),
  /**
   * `deny` cuts sandboxed commands off the network (localhost stays on macOS).
   * Not on Windows: low integrity cannot block the network.
   */
  network: AgentSandboxNetworkSchema.catch('allow').default('allow')
})
export type AgentSandboxSettings = z.infer<typeof AgentSandboxSettingsSchema>

export const DEFAULT_AGENT_SANDBOX: AgentSandboxSettings = {
  mode: 'off',
  network: 'allow'
}

/** Whether this machine can sandbox agent commands, and why not when it can't. */
export const SandboxCapabilitySchema = z.object({
  available: z.boolean(),
  /** `seatbelt` = macOS sandbox-exec, `bubblewrap` = Linux bwrap, `low-integrity` = Windows. */
  mechanism: z.enum(['seatbelt', 'bubblewrap', 'low-integrity']).nullable(),
  /** Why it is unavailable, in words fit to show; null when available. */
  reason: z.string().nullable()
})
export type SandboxCapability = z.infer<typeof SandboxCapabilitySchema>

/** `getSandboxCapability` takes no arguments; the preload sends `{}`. */
export const SandboxCapabilityRequestSchema = z.object({}).strict()

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

export const DictationLocalModelIdSchema = z.enum(['whisper-tiny.en', 'whisper-small.en', 'moonshine-base', 'whisper-small'])
export type DictationLocalModelId = z.infer<typeof DictationLocalModelIdSchema>

/** What Enter does while a take is open; Ctrl/Cmd+Enter does the other. */
export const DictationEnterActionSchema = z.enum(['insert', 'send'])
export type DictationEnterAction = z.infer<typeof DictationEnterActionSchema>

/**
 * The removed `waveformStyle` key needs no migration: `z.object` strips keys
 * it does not know, so a stored one is dropped on the next read.
 */
export const DictationSettingsSchema = z.object({
  /** Where the audio goes: a cloud transcription API, or Whisper on this machine. */
  engine: DictationEngineSchema.default('openai'),
  /** Which installed local model to use. Empty until the user selects/installs. */
  localModelId: z.union([z.literal(''), DictationLocalModelIdSchema]).default(''),
  /** `MediaDeviceInfo.deviceId` of the chosen microphone; empty follows the OS default. */
  deviceId: z.string().max(512).default(''),
  /** ISO-639-1 hint for the cloud engines and the multilingual local model; empty detects. The `.en` models are English-only. */
  language: z.string().max(8).default(''),
  /** Holding the shortcut records until it is let go; a tap still starts and stops a take. */
  holdToTalk: z.boolean().default(true),
  enterAction: DictationEnterActionSchema.default('insert'),
  /** OpenAI writes words while you speak (a live session) — about 4× the price per minute. */
  liveWords: z.boolean().default(false)
})
export type DictationSettings = z.infer<typeof DictationSettingsSchema>

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  engine: 'openai',
  localModelId: '',
  deviceId: '',
  language: '',
  holdToTalk: true,
  enterAction: 'insert',
  liveWords: false
}

/** The OS's answer about microphone access (Electron `getMediaAccessStatus`). */
export const DictationMicAccessSchema = z.enum(['granted', 'denied', 'restricted', 'not-determined', 'unknown'])
export type DictationMicAccess = z.infer<typeof DictationMicAccessSchema>

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
  loaded: z.boolean(),
  /** Typical time one phrase takes on this PC; null until it has run once since the app started. */
  callMs: z.number().nonnegative().nullable().optional()
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
export const SETTINGS_FORMAT_VERSION = 7

/**
 * One user-defined OpenAI-compatible provider entry. `id` is a dynamic
 * `custom:<slug>` id (see CustomProviderIdSchema); `name` is the display
 * label; `baseUrl` must be an OpenAI-compatible base URL (normalized to end
 * with `/v1` by the domain helpers).
 */
export const CustomProviderSchema = z.object({
  id: CustomProviderIdSchema,
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1),
  /**
   * `azure`: an Azure OpenAI / Foundry resource on its v1 API — the key goes
   * in an `api-key` header and models are deployment names. Unset: plain
   * OpenAI-compatible with a Bearer key.
   */
  kind: z.enum(['openai', 'azure']).optional(),
  /**
   * Extra request headers (gateway routing, org ids). Kept in settings, not
   * the key vault — secrets belong in the API key. Sanitized on use
   * (sanitizeCustomHeaders), so one bad entry never costs the endpoint.
   */
  headers: z.record(z.string(), z.string()).optional()
})
export type CustomProvider = z.infer<typeof CustomProviderSchema>

/**
 * Slug of the entry 1.0 builds seeded from the legacy single-provider field.
 * Reserved: new endpoints never get it, so dropLegacyCustomProviderSeed can
 * tell the seed apart from an endpoint the user added.
 */
export const DEFAULT_CUSTOM_PROVIDER_SLUG = 'default'
export const DEFAULT_CUSTOM_PROVIDER_ID = customProviderId(DEFAULT_CUSTOM_PROVIDER_SLUG)

/** Max saved custom endpoints; the picker and Settings list stay scannable. */
export const MAX_CUSTOM_PROVIDERS = 20

/**
 * A fresh `custom:<slug>` id for an endpoint named `name`: lowercase, hyphenated,
 * unique against `taken` (ids or slugs), never the reserved seed slug.
 */
export function newCustomProviderId(
  name: string,
  taken: Iterable<string>
): ReturnType<typeof customProviderId> {
  const used = new Set<string>()
  for (const id of taken) used.add(customProviderSlug(id) ?? id)
  used.add(DEFAULT_CUSTOM_PROVIDER_SLUG)
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'endpoint'
  let slug = base
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
  return customProviderId(slug)
}

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
    const base = customEndpointBaseUrl(parsed.data)
    if (seenBases.has(base)) continue
    seenIds.add(slug)
    seenBases.add(base)
    const { headers: rawHeaders, ...entry } = parsed.data
    const headers = sanitizeCustomHeaders(rawHeaders)
    out.push(headers ? { ...entry, headers } : entry)
  }
  return out
}

/**
 * Drop the `custom:default` entry 1.0 builds seeded from the legacy
 * `customOpenAiBaseUrl` field. It was never selectable, carried no key, and
 * copies the builtin Custom provider's URL — shown next to that provider it
 * would read as a duplicate, and its URL would block adding the same host.
 * Only the exact seed shape is dropped (reserved slug, seed name, same URL).
 */
export function dropLegacyCustomProviderSeed(
  list: readonly CustomProvider[],
  legacyBaseUrl: string | undefined
): CustomProvider[] {
  const legacy = normalizeCustomOpenAiBaseUrl(legacyBaseUrl ?? CUSTOM_OPENAI_DEFAULT)
  return list.filter(
    (entry) =>
      !(
        entry.id === DEFAULT_CUSTOM_PROVIDER_ID &&
        entry.name === 'Custom' &&
        normalizeCustomOpenAiBaseUrl(entry.baseUrl) === legacy
      )
  )
}

/** A provider and one of its models, for the helper and utility model settings. */
/** The editor "Open in editor" uses; `auto` = the first one installed, `system` = the OS default app. */
export const PreferredEditorSchema = z.enum([
  'auto',
  'vscode',
  'cursor',
  'windsurf',
  'zed',
  'sublime',
  'webstorm',
  'idea',
  'pycharm',
  'system'
])
export type PreferredEditor = z.infer<typeof PreferredEditorSchema>

export const ModelRefSchema = z.object({
  provider: ProviderIdSchemaAny,
  model: z.string().min(1)
})
export type ModelRef = z.infer<typeof ModelRefSchema>

/** Most fallback models that can stand behind the task's model. */
export const MAX_FALLBACK_MODELS = 3

/**
 * Models a step moves to when the task's provider is down (5xx/529,
 * connection refused/reset, DNS, timeouts) — never on a usage limit or rate
 * limit, which keep waiting on the task's own model (main/agent/modelFallback.ts).
 * Unreadable entries and repeats are dropped, and the list is capped, rather
 * than failing the settings file.
 */
export const ModelFallbackSettingsSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  models: z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const out: ModelRef[] = []
      for (const item of items) {
        const parsed = ModelRefSchema.safeParse(item)
        if (!parsed.success) continue
        if (out.some((m) => m.provider === parsed.data.provider && m.model === parsed.data.model)) continue
        out.push(parsed.data)
        if (out.length === MAX_FALLBACK_MODELS) break
      }
      return out
    })
    .default([])
})
export type ModelFallbackSettings = z.infer<typeof ModelFallbackSettingsSchema>

export const DEFAULT_MODEL_FALLBACK: ModelFallbackSettings = { enabled: false, models: [] }

/** web_search's engine. Brave and Tavily keys live in the key vault, not here. */
export const WebSearchProviderSchema = z.enum(['duckduckgo', 'brave', 'tavily', 'searxng'])
export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>

export const WebSearchSettingsSchema = z.object({
  provider: WebSearchProviderSchema.catch('duckduckgo').default('duckduckgo'),
  /** A SearXNG instance's address (`http://localhost:8888`), for provider `searxng`. */
  searxngUrl: z.string().trim().max(500).catch('').default('')
})
export type WebSearchSettings = z.infer<typeof WebSearchSettingsSchema>

export const DEFAULT_WEB_SEARCH: WebSearchSettings = { provider: 'duckduckgo', searxngUrl: '' }

/** Most prices that can be set by hand. */
export const MAX_CUSTOM_MODEL_PRICES = 100

const PriceRateSchema = z.number().finite().min(0).max(100_000)

/**
 * A per-model price set in Settings (USD per 1M tokens), matched before the
 * built-in table — see `resolveModelPrice` in shared/pricing/modelPrices.ts.
 */
export const CustomModelPriceSchema = z.object({
  /** Provider id (`custom:<slug>` for an added endpoint), or `*` for any. */
  provider: z.string().trim().min(1).max(80),
  /** Exact model id, or a prefix ending in `*`. */
  model: z.string().trim().min(1).max(200),
  input: PriceRateSchema,
  output: PriceRateSchema,
  cachedInput: PriceRateSchema.optional(),
  cacheWrite: PriceRateSchema.optional()
})
export type CustomModelPriceSetting = z.infer<typeof CustomModelPriceSchema>

/**
 * Spend across all tasks, in whole US dollars per local day and per calendar
 * month. 0 is off. Reaching one warns once in that period; it never stops a
 * task — the per-task limit is what stops.
 */
export const SpendBudgetSettingsSchema = z.object({
  dailyUsd: z.number().int().min(0).max(TASK_SPEND_LIMIT_MAX_USD).catch(0).default(0),
  monthlyUsd: z.number().int().min(0).max(TASK_SPEND_LIMIT_MAX_USD * 10).catch(0).default(0),
  /**
   * Once a budget is spent, new tasks, follow-ups, schedules and loops wait
   * until the next day or month (or a higher budget). Running tasks finish.
   */
  holdAtBudget: z.boolean().catch(false).default(false)
})
export type SpendBudgetSettings = z.infer<typeof SpendBudgetSettingsSchema>

export const DEFAULT_SPEND_BUDGET: SpendBudgetSettings = { dailyUsd: 0, monthlyUsd: 0, holdAtBudget: false }

export const SettingsSchema = z.object({
  provider: ProviderIdSchemaAny,
  model: z.string().min(1),
  ollamaBaseUrl: z.string().min(1),
  /** OpenAI-compatible base URL for the `custom` provider (must end with `/v1`). */
  customOpenAiBaseUrl: z.string().min(1).default('http://127.0.0.1:8080/v1'),
  /**
   * User-added OpenAI-compatible endpoints (`custom:<slug>` ids), each with
   * its own key. Global; deduped on load via normalizeCustomProviders. The
   * builtin `custom` provider and `customOpenAiBaseUrl` stay alongside them.
   */
  customProviders: z.array(CustomProviderSchema).default([]),
  /**
   * Context window / max output set by hand per model, keyed
   * `<providerId>::<modelId>` (modelLimitKey). Wins over the catalog, the
   * 128k guess and what a local server reports.
   */
  modelLimits: z
    .record(
      z.string().min(1).max(300),
      z.object({
        contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
        maxOutputTokens: z.number().int().min(256).max(1_000_000).optional()
      })
    )
    .default({}),
  /** Amazon Bedrock region (the key's calls go only to that region's host). */
  bedrockRegion: z.string().trim().regex(BEDROCK_REGION_RE).catch(BEDROCK_DEFAULT_REGION).default(BEDROCK_DEFAULT_REGION),
  /** Google Cloud project Vertex AI bills; empty until set up. */
  vertexProject: z
    .string()
    .trim()
    .refine((v) => v === '' || VERTEX_PROJECT_RE.test(v))
    .catch('')
    .default(''),
  /** Vertex AI location: `global`, `us`/`eu`, or a region like `us-east5`. */
  vertexLocation: z.string().trim().regex(VERTEX_LOCATION_RE).catch(VERTEX_DEFAULT_LOCATION).default(VERTEX_DEFAULT_LOCATION),
  network: NetworkSettingsSchema.default(DEFAULT_NETWORK_SETTINGS),
  theme: ThemeIdSchema,
  navigationMode: NavigationModeSchema.default(DEFAULT_NAVIGATION_MODE),
  fontScale: FontScaleSchema.default(DEFAULT_FONT_SCALE),
  skinId: SkinIdSchema.catch(DEFAULT_SKIN_ID).default(DEFAULT_SKIN_ID),
  /** Local user CSS overlay path. Empty = none. */
  customCssPath: z.string().default(''),
  /**
   * Motion preference. `system` follows the OS reduced-motion setting,
   * `on` always reduces motion, `off` keeps app motion (the OS setting can
   * still reduce motion through the media query).
   */
  reduceMotion: ReduceMotionSchema.default(DEFAULT_REDUCE_MOTION),
  /** Contrast preference. `system` follows the OS, `more` strengthens borders and text. */
  contrast: ContrastSchema.default(DEFAULT_CONTRAST),
  /** When true, the focus ring shows on focus, not just keyboard focus. */
  alwaysShowFocusRing: z.boolean().default(DEFAULT_ALWAYS_SHOW_FOCUS_RING),
  /** How much screen readers are told: nothing, failures/questions only, or everything. */
  announceVerbosity: AnnounceVerbositySchema.default(DEFAULT_ANNOUNCE_VERBOSITY),
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
  /**
   * Keep Anthropic's prompt cache for an hour instead of five minutes. A
   * prefix written with the long cache costs 2x base input instead of 1.25x,
   * but survives an approval or question wait, which otherwise re-sends the
   * whole prompt at full price. Off by default: worth it only when runs often
   * wait on you (see `pnpm usage:report`, "idle" misses).
   */
  longPromptCache: z.boolean().default(false),
  favoriteModels: z.array(z.string()).default([]),
  /** Session keys (`${workspacePath}␀${runId}`) pinned above the Home recency list. */
  pinnedRuns: z.array(z.string()).max(24).default([]),
  /** Session keys (same shape as pinnedRuns) put out of the navigator's way without deleting them. */
  archivedRuns: z.array(z.string()).max(500).default([]),
  recentModels: z.array(z.string()).max(5).default([]),
  thinkingPrefsByProvider: z.partialRecord(ProviderIdSchemaAny, ThinkingPrefsSchema).default({}),
  serviceTierByModel: z.record(z.string(), ServiceTierSchema).default({}),
  serviceTier: ServiceTierSchema.default('default'),
  toolApproval: ToolApprovalSettingsSchema.default(DEFAULT_TOOL_APPROVAL),
  /**
   * Minutes an approval card waits before the call is denied; 0 waits for an
   * answer however long that takes (an unattended run then parks there).
   */
  approvalTimeoutMinutes: z.number().int().min(0).max(1440).default(15),
  /** Default search engine for browser_search. */
  searchEngine: SearchEngineSchema.default('duckduckgo'),
  /** Where web_search asks: DuckDuckGo's HTML page (no key), a search API, or your SearXNG. */
  webSearch: WebSearchSettingsSchema.catch(DEFAULT_WEB_SEARCH).default(DEFAULT_WEB_SEARCH),
  /**
   * When non-empty, agent browser navigation is limited to these hostnames
   * (exact or `*.suffix` wildcards). Empty = no extra host filter (SSRF rules still apply).
   */
  browserDomainAllowlist: z.array(z.string().min(1)).default([]),
  /** Set once an approval mode is chosen on the Set up page; until then Set up shows. */
  toolApprovalOnboardingDone: z.boolean().default(false),
  /** Shell used by the terminal tool. `auto` prefers PowerShell on Windows when available. */
  terminalShell: TerminalShellSchema.default('auto'),
  /** Where "Open in editor" opens files, folders and worktrees. */
  preferredEditor: PreferredEditorSchema.default('auto'),
  /**
   * Terminal screen-reader mode. `auto` follows OS assistive-tech detection
   * (Chromium reports it via accessibility-support-changed); `on`/`off` force
   * it. xterm screenReaderMode maintains a parallel DOM per write, so forcing
   * it on without a screen reader costs significant CPU on chatty output.
   */
  terminalScreenReader: z.enum(['auto', 'on', 'off']).default('auto'),
  /**
   * Draw the terminal with WebGL (@xterm/addon-webgl). Much faster on busy
   * output; falls back to the DOM renderer when WebGL is missing or its
   * context is lost. Off is for GPUs that draw it wrong.
   */
  terminalGpuRendering: z.boolean().default(true),
  /** OS sandbox for agent-run commands. Never applies to the terminal panel you type into. */
  agentSandbox: AgentSandboxSettingsSchema.catch(DEFAULT_AGENT_SANDBOX).default(DEFAULT_AGENT_SANDBOX),
  /**
   * Optional override for the diagnostics tool typecheck command.
   * Empty = auto-detect from package.json scripts / tsc.
   */
  diagnosticsCommand: z.string().default(''),
  /** A shell program for the terminal panel's own tabs (blank: the Shell setting). Not the agent's. */
  terminalShellPath: z.string().max(1024).default(''),
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
   * New task opens on "New worktree" instead of "This folder" (renderer only;
   * the page still lets each task choose, and a folder with no commit to
   * branch from starts here either way).
   */
  newTaskWorktree: z.boolean().default(false),
  /**
   * Sub-agents (inline instances) one task may run at the same time. A spawn
   * past it is refused and the agent is told to await one first. The default
   * is above what a task uses in practice, so it changes nothing until lowered.
   */
  maxParallelInstances: z.number().int().min(1).max(MAX_PARALLEL_INSTANCES_LIMIT).default(DEFAULT_MAX_PARALLEL_INSTANCES),
  /**
   * Whole dollars a task may spend on models, its helper instances included,
   * before it stops at a step and asks (main/agent/taskSpend.ts). 0 is off.
   * Priced models only: a step with no billed or published price adds nothing.
   */
  taskSpendLimitUsd: z.number().int().min(0).max(TASK_SPEND_LIMIT_MAX_USD).default(0),
  /** Daily and monthly spend across tasks; reaching one warns, never stops. */
  spendBudget: SpendBudgetSettingsSchema.catch(DEFAULT_SPEND_BUDGET).default(DEFAULT_SPEND_BUDGET),
  /**
   * Prices set by hand for models the table and models.dev do not price, or
   * price differently. Unreadable entries are dropped rather than failing
   * the settings file.
   */
  customModelPrices: z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const out: CustomModelPriceSetting[] = []
      for (const item of items) {
        const parsed = CustomModelPriceSchema.safeParse(item)
        if (parsed.success) out.push(parsed.data)
        if (out.length === MAX_CUSTOM_MODEL_PRICES) break
      }
      return out
    })
    .default([]),
  /**
   * Draft a commit message in the background while Changes shows uncommitted
   * work. Off: the message is written when Commit… opens. Each draft is a
   * billed model call, recorded in Usage.
   */
  commitMessageAutoDraft: z.boolean().default(false),
  /**
   * Model helper instances run on. Null: the task's own model — the one the
   * task was started with, not the workspace default.
   */
  helperModel: ModelRefSchema.nullable().default(null),
  /**
   * Cheaper model for side calls — compaction summaries and commit messages.
   * Null: the task's model. Compaction still sizes what it keeps by the task's
   * model; only the summary is written by this one.
   */
  utilityModel: ModelRefSchema.nullable().default(null),
  /** Fallback models for when the task's provider is down. Off by default. */
  modelFallback: ModelFallbackSettingsSchema.catch(DEFAULT_MODEL_FALLBACK).default(DEFAULT_MODEL_FALLBACK),
  /**
   * Maximum simultaneously visible chat panes (split session view). 0 = Auto:
   * derived from the viewport (min 280px per pane, hard cap 6). 1–6 is a fixed
   * limit that may exceed what fits — the pane row scrolls horizontally.
   */
  maxChatPanes: z.number().int().min(0).max(6).default(0),
  /** Packaged builds check for app updates at launch and every 6 hours. */
  autoCheckUpdates: z.boolean().default(true),
  /** `beta` also offers releases marked pre-release; never downgrades back to stable. */
  updateChannel: z.enum(['stable', 'beta']).catch('stable').default('stable'),
  /**
   * Closing the window hides it to the tray instead of quitting, so tasks,
   * loops and schedules keep going (Windows and Linux; a Mac app already
   * keeps running). Quit from the tray or the menu.
   */
  closeToTray: z.boolean().default(false),
  /** Ask before a close or quit stops running tasks. */
  confirmQuitWithRunningTasks: z.boolean().default(true),
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
  /** Voice mode: providers, voice and behaviour (docs/voice-mode.md §12). */
  voice: VoiceSettingsSchema.default(DEFAULT_VOICE_SETTINGS),
  /**
   * "Approve low-risk tools on their own": auto-approve gated tools that are
   * not high-risk (see isAutonomousHighRiskTool). Off by default.
   */
  autonomousMode: z.boolean().default(false),
  /**
   * "When the agent asks a question": skip ask_question (and decline MCP
   * servers' questions) immediately, or wait for the user's answer. Applies
   * whatever autonomousMode says (v7 on). There is no question timeout, so
   * 'wait' can park a run nobody is watching until someone answers or cancels it.
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
  notifications: NotificationSettingsSchema.default(DEFAULT_NOTIFICATION_SETTINGS),
  /** Shortcuts rebound from their defaults, by shortcut id; absent ids use the built-in keys. */
  shortcutOverrides: z.record(z.string(), ShortcutChordSchema).catch({}).default({})
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  model: 'qwen2.5',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1',
  customProviders: [],
  modelLimits: {},
  bedrockRegion: BEDROCK_DEFAULT_REGION,
  vertexProject: '',
  vertexLocation: VERTEX_DEFAULT_LOCATION,
  network: DEFAULT_NETWORK_SETTINGS,
  theme: 'system',
  navigationMode: DEFAULT_NAVIGATION_MODE,
  fontScale: DEFAULT_FONT_SCALE,
  skinId: DEFAULT_SKIN_ID,
  customCssPath: '',
  reduceMotion: DEFAULT_REDUCE_MOTION,
  contrast: DEFAULT_CONTRAST,
  alwaysShowFocusRing: DEFAULT_ALWAYS_SHOW_FOCUS_RING,
  announceVerbosity: DEFAULT_ANNOUNCE_VERBOSITY,
  telemetryEnabled: false,
  mcpServers: [],
  mcpToolLoading: 'on-demand',
  keepRecentTurns: 12,
  autoCompactThresholdRatio: DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  settingsVersion: SETTINGS_FORMAT_VERSION,
  thinkingEnabled: true,
  thinkingEffort: DEFAULT_THINKING_EFFORT,
  showThinking: true,
  longPromptCache: false,
  favoriteModels: [],
  pinnedRuns: [],
  archivedRuns: [],
  recentModels: [],
  thinkingPrefsByProvider: {},
  serviceTierByModel: {},
  serviceTier: 'default',
  toolApproval: DEFAULT_TOOL_APPROVAL,
  approvalTimeoutMinutes: 15,
  searchEngine: 'duckduckgo',
  webSearch: DEFAULT_WEB_SEARCH,
  browserDomainAllowlist: [],
  toolApprovalOnboardingDone: false,
  terminalShell: 'auto',
  preferredEditor: 'auto',
  terminalScreenReader: 'auto',
  terminalGpuRendering: true,
  agentSandbox: DEFAULT_AGENT_SANDBOX,
  diagnosticsCommand: '',
  terminalShellPath: '',
  autoModeSwitch: true,
  autoResumeInterruptedRuns: true,
  newTaskWorktree: false,
  maxParallelInstances: DEFAULT_MAX_PARALLEL_INSTANCES,
  taskSpendLimitUsd: 0,
  spendBudget: DEFAULT_SPEND_BUDGET,
  customModelPrices: [],
  commitMessageAutoDraft: false,
  helperModel: null,
  utilityModel: null,
  modelFallback: DEFAULT_MODEL_FALLBACK,
  maxChatPanes: 0,
  autoCheckUpdates: true,
  updateChannel: 'stable',
  closeToTray: false,
  confirmQuitWithRunningTasks: true,
  googleMcpClientId: '',
  marketplace: DEFAULT_MARKETPLACE_SETTINGS,
  codeIndex: DEFAULT_CODE_INDEX_SETTINGS,
  dictation: DEFAULT_DICTATION_SETTINGS,
  voice: DEFAULT_VOICE_SETTINGS,
  autonomousMode: false,
  autonomousSkipQuestions: 'wait',
  storage: DEFAULT_STORAGE_SETTINGS,
  storageSurfaceAcked: false,
  userRules: [],
  agentPersona: '',
  agentTone: '',
  agentIdentity: '',
  responseLanguage: '',
  responseVerbosity: 'concise',
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  shortcutOverrides: {}
}

/**
 * A patch: exactly the keys the caller sent. zod 4 runs `.default()` even
 * under `.partial()`, so a plain `SettingsSchema.partial()` would answer a
 * one-key patch with every default filled in and `setSettings` would reset
 * every other setting. The fields' own defaults are peeled first; nested
 * objects that arrive still get theirs.
 */
export const SetSettingsRequestSchema = SettingsSchema.extend(
  Object.fromEntries(
    Object.entries(SettingsSchema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.unwrap() : field
    ])
  )
).partial() as unknown as ReturnType<typeof SettingsSchema.partial>
export type SetSettingsRequest = z.infer<typeof SetSettingsRequestSchema>

export const WindowMaximizedChangedSchema = z.boolean()

export const TelemetryStatusSchema = z.object({
  dsnConfigured: z.boolean(),
  telemetryEnabled: z.boolean()
})
export type TelemetryStatus = z.infer<typeof TelemetryStatusSchema>

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
