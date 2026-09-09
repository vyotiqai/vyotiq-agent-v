import { z } from 'zod'
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
  type ThinkingEffort
} from './providers'
import { DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO } from '../../domain/contextBudget'
import {
  DEFAULT_MARKETPLACE_SETTINGS,
  MarketplaceSettingsSchema,
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
      googleAccess: z.enum(['read', 'read-write']).optional()
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

export const CodeIndexEmbedderSchema = z.enum(['mdenseon', 'lfm2', 'ollama', 'hash'])
export type CodeIndexEmbedderSetting = z.infer<typeof CodeIndexEmbedderSchema>

export const CodeIndexSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Default: LightOn dense ONNX — batched inference in the utilityProcess
   * (~10× the throughput of sequential llama.cpp). LFM2.5-Embedding-350M
   * resolves to local ONNX export → llama.cpp GGUF → DenseOn fallback.
   */
  embedder: CodeIndexEmbedderSchema.default('mdenseon'),
  /** Download ONNX weights into userData on first use. */
  autoDownload: z.boolean().default(true),
  /** Ollama embedding model when embedder=ollama. */
  ollamaModel: z.string().min(1).default('nomic-embed-text'),
  /** Ollama model serving the LFM2.5-Embedding GGUF when embedder=lfm2 and no local ONNX. */
  lfm2OllamaModel: z.string().min(1).default('hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF')
})
export type CodeIndexSettings = z.infer<typeof CodeIndexSettingsSchema>

export const DEFAULT_CODE_INDEX_SETTINGS: CodeIndexSettings = {
  enabled: true,
  embedder: 'mdenseon',
  autoDownload: true,
  ollamaModel: 'nomic-embed-text',
  lfm2OllamaModel: 'hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF'
}

export const CodeIndexModelPhaseSchema = z.enum([
  'idle',
  'ready',
  'downloading',
  'loading',
  'indexing',
  'fallback_hash',
  'error'
])
export type CodeIndexModelPhase = z.infer<typeof CodeIndexModelPhaseSchema>

export const CodeIndexSyncProgressSchema = z.object({
  kind: z.enum(['code', 'sparse']),
  stage: z.enum(['walking', 'scanning', 'embedding', 'reconciling', 'done']),
  filesDone: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Chunks embedded so far in this sync (code index only). */
  embedChunks: z.number().int().nonnegative(),
  currentPath: z.string().nullable()
})
export type CodeIndexSyncProgress = z.infer<typeof CodeIndexSyncProgressSchema>

export const CodeIndexRuntimeStatusSchema = z.object({
  phase: CodeIndexModelPhaseSchema,
  modelId: z.string(),
  embedder: CodeIndexEmbedderSchema,
  /** 0–1 overall fraction for the active phase (download or index sync). */
  progress: z.number().nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  modelDir: z.string().nullable(),
  /** Live file/embed counters while phase === 'indexing'. */
  indexProgress: CodeIndexSyncProgressSchema.nullable().default(null)
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
  byType: z.array(ProcessMetricsByTypeSchema),
  embedUtility: z.object({
    pid: z.number().nullable(),
    sessionLoaded: z.boolean(),
    rssMb: z.number().nullable(),
    heapUsedMb: z.number().nullable()
  })
})
export type ProcessMetricsSnapshot = z.infer<typeof ProcessMetricsSnapshotSchema>

export const CodeIndexReindexRequestSchema = z.object({
  workspacePath: z.string().min(1).optional()
})
export type CodeIndexReindexRequest = z.infer<typeof CodeIndexReindexRequestSchema>

export const DictationEngineSchema = z.enum(['openai', 'openrouter', 'local', 'qwen3-asr', 'qwen3-asr-onnx'])
export type DictationEngine = z.infer<typeof DictationEngineSchema>

export const DictationLocalModelIdSchema = z.enum([
  'whisper-tiny.en',
  'whisper-small.en',
  'qwen3-asr-0.6b',
  'qwen3-asr-1.7b',
  'qwen3-asr-onnx-0.6b',
  'qwen3-asr-onnx-1.7b'
])
export type DictationLocalModelId = z.infer<typeof DictationLocalModelIdSchema>

export const DictationWaveformStyleSchema = z.enum(['bars', 'dots', 'line', 'mirror'])
export type DictationWaveformStyle = z.infer<typeof DictationWaveformStyleSchema>

export const DictationSettingsSchema = z.object({
  /** Cloud vs on-device STT. Default keeps today's OpenAI path. */
  engine: DictationEngineSchema.default('openai'),
  /** Which installed local model to use. Empty until the user selects/installs. */
  localModelId: z.union([z.literal(''), DictationLocalModelIdSchema]).default(''),
  /** Composer listening visualizer. */
  waveformStyle: DictationWaveformStyleSchema.default('bars'),
  /**
   * OpenAI-compatible transcription base URL for the `qwen3-asr` engine.
   * Point this at a running vLLM (`vllm serve Qwen/Qwen3-ASR-…`, base
   * `http://127.0.0.1:8000/v1`) or `qwen-asr-serve` endpoint. The app POSTs
   * `<url>/audio/transcriptions`; it does not download the model.
   */
  qwen3AsrServerUrl: z.string().min(1).default('http://127.0.0.1:8000/v1'),
  /** Optional bearer token for the Qwen3-ASR server. Empty = no auth header. */
  qwen3AsrApiKey: z.string().default('')
})
export type DictationSettings = z.infer<typeof DictationSettingsSchema>

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  engine: 'openai',
  localModelId: '',
   waveformStyle: 'bars',
   qwen3AsrServerUrl: 'http://127.0.0.1:8000/v1',
   qwen3AsrApiKey: ''
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

/** Current persisted settings format. Bump with a matching load-time rewrite. */
export const SETTINGS_FORMAT_VERSION = 2

export const SettingsSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1),
  ollamaBaseUrl: z.string().min(1),
  /** OpenAI-compatible base URL for the `custom` provider (must end with `/v1`). */
  customOpenAiBaseUrl: z.string().min(1).default('http://127.0.0.1:8080/v1'),
  theme: ThemeIdSchema,
  navigationMode: NavigationModeSchema.default(DEFAULT_NAVIGATION_MODE),
  fontScale: FontScaleSchema.default(DEFAULT_FONT_SCALE),
  uiDensity: UiDensitySchema.default(DEFAULT_UI_DENSITY),
  skinId: SkinIdSchema.catch(DEFAULT_SKIN_ID).default(DEFAULT_SKIN_ID),
  /** Local user CSS overlay path. Empty = none. */
  customCssPath: z.string().default(''),
  telemetryEnabled: z.boolean().default(false),
  mcpServers: z.array(McpServerSchema).default([]),
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
   * When false, only the user changes mode (composer picker or slash). Default off.
   * Live runs re-read this at each step boundary (next step picks up a toggle).
   */
  autoModeSwitch: z.boolean().default(false),
  /**
   * When true, opening an interrupted chat resumes automatically instead of showing Continue.
   */
  autoResumeInterruptedRuns: z.boolean().default(false),
  /** Packaged builds check GitHub Releases for app updates on launch. */
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
   * Unattended runs: auto-approve gated tools (high-risk still gated) and relax
   * offline wait_forever. Off by default.
   */
  autonomousMode: z.boolean().default(false),
  /**
   * When autonomousMode is on: skip ask_question immediately, or wait for answers
   * until the normal 15-minute question timeout.
   */
  autonomousSkipQuestions: AutonomousSkipQuestionsSchema.default('wait'),
  /** Offline connectivity wait budget (autonomousMode gates wait_forever). */
  offlineWaitMode: OfflineWaitModeSchema.default('default'),
  /**
   * Per-run budget guards, checked at each step boundary against cumulative
   * provider-reported cost (USD) and total tokens (billed input + output).
   * 0 disables each cap.
   */
  runSpendLimitUsd: z.number().min(0).default(0),
  runTokenLimit: z.number().int().min(0).default(0),
  /**
   * User-global rules injected as `<user_rules>` on every agent step.
   * Disabled rules are omitted. Workspace rules override these on conflict.
   */
  userRules: z.array(UserRuleSchema).max(MAX_USER_RULES).default([]),
  /** Optional assistant identity surfaced in the stable prompt zone. Empty = default. */
  agentPersona: z.string().max(1000).default(''),
  /** Optional tone directive for replies. Empty = default spine tone. */
  agentTone: z.string().max(2000).default(''),
  /** Preferred response language. Empty = follow the user's language. */
  responseLanguage: z.string().max(64).default(''),
  /** Default answer length for conversational replies. */
  responseVerbosity: ResponseVerbositySchema.default('concise'),
  /**
   * App-wide inbox + OS toast preferences. Not a workspace override.
   */
  notifications: NotificationSettingsSchema.default(DEFAULT_NOTIFICATION_SETTINGS),
  /**
   * Ghost-text fill-in-the-middle in the Files editor using the active model.
   * Tab accepts, Esc dismisses. Calls the active provider while typing.
   */
  tabAutocomplete: z.boolean().default(true)
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  provider: 'ollama',
  model: 'qwen2.5',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1',
  theme: 'system',
  navigationMode: DEFAULT_NAVIGATION_MODE,
  fontScale: DEFAULT_FONT_SCALE,
  uiDensity: DEFAULT_UI_DENSITY,
  skinId: DEFAULT_SKIN_ID,
  customCssPath: '',
  telemetryEnabled: false,
  mcpServers: [],
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
  autoModeSwitch: false,
  autoResumeInterruptedRuns: false,
  autoCheckUpdates: true,
  googleMcpClientId: '',
  marketplace: DEFAULT_MARKETPLACE_SETTINGS,
  codeIndex: DEFAULT_CODE_INDEX_SETTINGS,
  dictation: DEFAULT_DICTATION_SETTINGS,
  autonomousMode: false,
  autonomousSkipQuestions: 'wait',
  offlineWaitMode: 'default',
  runSpendLimitUsd: 0,
  runTokenLimit: 0,
  userRules: [],
  agentPersona: '',
  agentTone: '',
  responseLanguage: '',
  responseVerbosity: 'concise',
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  tabAutocomplete: true
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
