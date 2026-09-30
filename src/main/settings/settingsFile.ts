import {
  DEFAULT_SETTINGS,
  normalizeCustomProviders,
  SettingsSchema,
  type CustomProvider,
  type Settings
} from '../../shared/ipc'
import { isCustomProviderId } from '../../shared/ipc/schemas/providers'
import type { SettingsImportChange, SettingsImportPreview } from '../../shared/ipc/schemas/settingsFile'

/**
 * Settings as a file: export, import (previewed, then applied), and reset.
 * Keys never leave the key vault, so none of this touches them.
 */

export const SETTINGS_FILE_FORMAT = 'vyotiq-settings'
export const SETTINGS_FILE_VERSION = 1
/** A settings file is a few KB; anything this size is not one. */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024

type Key = keyof Settings

/**
 * What an export carries. An allowlist, so a field added later stays out until
 * someone decides it belongs. Left out: MCP servers (their secrets are restored
 * in memory), consent and onboarding flags, machine paths, and history (pins,
 * archive, recent models).
 */
export const EXPORTED_KEYS: readonly Key[] = [
  'provider',
  'model',
  'ollamaBaseUrl',
  'customOpenAiBaseUrl',
  'customProviders',
  'bedrockRegion',
  'vertexProject',
  'vertexLocation',
  'network',
  'theme',
  'navigationMode',
  'fontScale',
  'skinId',
  'telemetryEnabled',
  'mcpToolLoading',
  'keepRecentTurns',
  'autoCompactThresholdRatio',
  'thinkingEnabled',
  'thinkingEffort',
  'showThinking',
  'favoriteModels',
  'thinkingPrefsByProvider',
  'serviceTierByModel',
  'serviceTier',
  'toolApproval',
  'searchEngine',
  'browserDomainAllowlist',
  'terminalShell',
  'terminalScreenReader',
  'diagnosticsCommand',
  'autoModeSwitch',
  'autoResumeInterruptedRuns',
  'maxParallelInstances',
  'taskSpendLimitUsd',
  'helperModel',
  'utilityModel',
  'maxChatPanes',
  'autoCheckUpdates',
  'codeIndex',
  'dictation',
  'autonomousMode',
  'autonomousSkipQuestions',
  'storage',
  'userRules',
  'agentPersona',
  'agentTone',
  'agentIdentity',
  'responseLanguage',
  'responseVerbosity',
  'notifications',
  'shortcutOverrides'
]

/**
 * Exported, but never imported: a file someone hands you must not decide where
 * your saved keys are sent (a base URL), route your traffic (the proxy), turn
 * telemetry on, run a command (diagnostics), or loosen approvals and autonomy.
 * Set these by hand.
 */
export const IMPORT_SKIPPED_KEYS: ReadonlyMap<Key, string> = new Map<Key, string>([
  ['ollamaBaseUrl', 'where the Ollama key is sent'],
  ['customOpenAiBaseUrl', 'where the Custom key is sent'],
  ['network', 'the proxy'],
  ['telemetryEnabled', 'crash reporting'],
  ['diagnosticsCommand', 'a command the app runs'],
  ['toolApproval', 'what runs without asking'],
  ['browserDomainAllowlist', 'sites the browser opens without asking'],
  ['autonomousMode', 'autonomous mode'],
  ['autonomousSkipQuestions', 'autonomous mode']
])

/** Kept by Reset all: keys' endpoints, sign-ins, extensions, consent, and your data. */
export const RESET_KEPT_KEYS: readonly Key[] = [
  'provider',
  'model',
  'ollamaBaseUrl',
  'customOpenAiBaseUrl',
  'customProviders',
  'bedrockRegion',
  'vertexProject',
  'vertexLocation',
  'mcpServers',
  'googleMcpClientId',
  'marketplace',
  'toolApprovalOnboardingDone',
  'storageSurfaceAcked',
  'pinnedRuns',
  'archivedRuns',
  'favoriteModels',
  'recentModels',
  'thinkingPrefsByProvider',
  'serviceTierByModel',
  'userRules',
  'settingsVersion'
]

/** The export: the allowlisted fields, with endpoint headers and machine-only values removed. */
export function buildSettingsExport(settings: Settings, appVersion: string, now = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of EXPORTED_KEYS) {
    const value = settings[key]
    if (value === undefined) continue
    out[key] = structuredClone(value)
  }
  // Header values may hold a gateway token; the names alone aren't worth a half entry.
  out.customProviders = (settings.customProviders ?? []).map(({ headers: _headers, ...entry }) => entry)
  const codeIndex = out.codeIndex as Record<string, unknown> | undefined
  if (codeIndex) delete codeIndex.pausedPaths
  const dictation = out.dictation as Record<string, unknown> | undefined
  if (dictation) delete dictation.deviceId
  return {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    appVersion,
    exportedAt: now.toISOString(),
    settings: out
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Read a settings file against the current settings: what would change, what
 * is skipped and why, and the patch to apply. Each field is checked on its
 * own, so one bad value costs that field, not the file.
 */
export function previewSettingsImport(
  raw: string,
  current: Settings
): { preview: SettingsImportPreview; patch: Partial<Settings> } {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new Error('That file is not JSON.')
  }
  const envelope = doc as { format?: unknown; version?: unknown; settings?: unknown }
  if (!envelope || typeof envelope !== 'object' || envelope.format !== SETTINGS_FILE_FORMAT) {
    throw new Error('That is not an Agent V settings file.')
  }
  if (typeof envelope.version !== 'number' || envelope.version > SETTINGS_FILE_VERSION) {
    throw new Error('That settings file is from a newer Agent V. Update, then import it.')
  }
  if (!envelope.settings || typeof envelope.settings !== 'object') {
    throw new Error('That settings file has no settings in it.')
  }
  const incoming = envelope.settings as Record<string, unknown>
  const patch: Partial<Settings> = {}
  const changes: SettingsImportChange[] = []
  const skipped: Array<{ key: string; reason: string }> = []
  const shape = SettingsSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>

  for (const [key, value] of Object.entries(incoming)) {
    const k = key as Key
    if (!EXPORTED_KEYS.includes(k)) {
      skipped.push({ key, reason: 'not something a settings file sets' })
      continue
    }
    const why = IMPORT_SKIPPED_KEYS.get(k)
    if (why) {
      if (!same(value, current[k])) skipped.push({ key, reason: `${why}: set it by hand` })
      continue
    }
    const field = shape[key]
    const parsed = field?.safeParse(value)
    if (!parsed?.success) {
      skipped.push({ key, reason: 'not a valid value' })
      continue
    }
    let next = parsed.data as Settings[Key]
    if (k === 'customProviders') {
      // Add endpoints the file has and you don't. An endpoint you have keeps
      // its URL — changing it would send its saved key somewhere new — and
      // none is removed, since removing one deletes its key.
      const mine = current.customProviders ?? []
      const added = (next as CustomProvider[]).filter((entry) => !mine.some((m) => m.id === entry.id))
      next = normalizeCustomProviders([...mine, ...added]) as Settings[Key]
    }
    if (k === 'codeIndex' || k === 'dictation') {
      // Machine-only fields stay as they are here.
      const here = current[k] as Record<string, unknown>
      const keep = k === 'codeIndex' ? 'pausedPaths' : 'deviceId'
      next = { ...(next as Record<string, unknown>), [keep]: here[keep] } as Settings[Key]
    }
    if (same(next, current[k])) continue
    ;(patch as Record<string, unknown>)[k] = next
    changes.push({ key, from: current[k] ?? null, to: next ?? null })
  }

  // A task provider that is an endpoint the result doesn't have can't be used.
  const endpoints = (patch.customProviders ?? current.customProviders ?? []).map((e) => e.id)
  const provider = patch.provider ?? current.provider
  if (isCustomProviderId(provider) && !endpoints.includes(provider)) {
    if (patch.provider !== undefined) {
      skipped.push({ key: 'provider', reason: 'an endpoint that is not set up here' })
      delete patch.provider
      delete patch.model
      for (let i = changes.length - 1; i >= 0; i--) {
        if (changes[i]!.key === 'provider' || changes[i]!.key === 'model') changes.splice(i, 1)
      }
    }
  }
  return { preview: { changes, skipped }, patch }
}

/** Everything back to its default, except what Reset all keeps. */
export function buildSettingsReset(current: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as Key[]) {
    if (RESET_KEPT_KEYS.includes(key)) continue
    if (same(current[key], DEFAULT_SETTINGS[key])) continue
    ;(patch as Record<string, unknown>)[key] = structuredClone(DEFAULT_SETTINGS[key])
  }
  // The index keeps which folders you paused.
  if (patch.codeIndex) patch.codeIndex = { ...patch.codeIndex, pausedPaths: current.codeIndex.pausedPaths }
  return patch
}
