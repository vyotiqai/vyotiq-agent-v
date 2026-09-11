import { app } from 'electron'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  SETTINGS_FORMAT_VERSION,
  SettingsSchema,
  type Settings,
  type StorageSettings
} from '../../shared/ipc'
import { DEFAULT_THINKING_EFFORT, LEGACY_THINKING_EFFORT } from '../../shared/ipc/schemas/providers'
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO,
  LEGACY_AUTO_COMPACT_THRESHOLD_RATIO
} from '../../shared/domain/contextBudget'
import {
  defaultModelFor,
  normalizeCustomOpenAiBaseUrl,
  ollamaNativeHost,
  validateCustomOpenAiBaseUrl,
  validateOllamaBaseUrl
} from '../../shared/providers'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { sanitizeMcpManifestEnv } from '../marketplace/sanitizeMcpEnv'
import { getAuthorizationHeader, getBearerToken, headersWithoutAuthorization } from '../../shared/utils/mcpAuth'
import {
  clearMcpServerSecrets,
  clearMcpAuthToken,
  clearMcpOAuthState,
  clearMcpOAuthClientSecret,
  clearGoogleMcpClientSecret,
  hasGoogleMcpClientSecret,
  getMcpServerSecrets,
  setMcpAuthToken,
  setMcpServerSecrets,
  type McpServerSecrets
} from './secrets'
import { isGoogleMcpId } from '../../shared/mcpApps'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function writeSettings(next: Settings): void {
  atomicWriteJson(settingsPath(), next, 0o600)
  settingsCache = next
}

let settingsCache: Settings | null = null

/** Serializes async callers that must await between settings mutations (IPC handlers). */
let settingsMutationChain: Promise<unknown> = Promise.resolve()

/**
 * Queue a settings mutation so async IPC handlers cannot interleave
 * get→await→set RMW outside of setSettings itself.
 */
export function enqueueSettingsMutation<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = settingsMutationChain.then(() => fn())
  settingsMutationChain = run.then(
    () => undefined,
    (err) => {
      logger.warn('Settings mutation failed; continuing chain', { scope: 'settings', err })
    }
  )
  return run
}

export const REDACTED_VALUE = '[redacted]'

function hasMcpSecretValue(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value !== REDACTED_VALUE
}

function extractAndRedactMcpSecrets(settings: Settings): Settings {
  if (!settings.mcpServers?.length) return settings

  let changed = false
  const mcpServers = settings.mcpServers.map((s) => {
    const safeEnv = sanitizeMcpManifestEnv(s.env)
    const authHeader = getAuthorizationHeader(s.headers)
    const safeHeaders = headersWithoutAuthorization(s.headers)

    const toStore: McpServerSecrets = { env: {}, headers: {} }

    if (safeEnv) {
      for (const [key, value] of Object.entries(safeEnv)) {
        // Never persist redaction placeholders or non-secret launch defaults.
        if (value === REDACTED_VALUE) continue
        if (key.toUpperCase() === 'PYTHONIOENCODING') continue
        if (!hasMcpSecretValue(value)) continue
        toStore.env[key] = value
      }
    }
    if (safeHeaders) {
      for (const [key, value] of Object.entries(safeHeaders)) {
        if (value === REDACTED_VALUE) continue
        if (!hasMcpSecretValue(value)) continue
        toStore.headers[key] = value
      }
    }
    // Never persist Authorization in settings.json — store in secrets (and Bearer token store).
    if (authHeader && hasMcpSecretValue(authHeader)) {
      toStore.headers.Authorization = authHeader
    }

    const hasSecretsToStore =
      Object.keys(toStore.env).length > 0 || Object.keys(toStore.headers).length > 0

    if (hasSecretsToStore) {
      try {
        setMcpServerSecrets(s.id, toStore)
      } catch (err) {
        logger.error('Failed to store MCP server secrets; refusing plaintext fallback', {
          scope: 'settings',
          serverId: s.id,
          err
        })
        throw new Error(
          `Cannot save MCP secrets for "${s.id}" to secure storage. Fix OS keychain/safeStorage and retry.`
        )
      }
    } else {
      try {
        clearMcpServerSecrets(s.id)
      } catch {
        // best-effort cleanup
      }
    }

    const bearer = getBearerToken(authHeader ? { Authorization: authHeader } : undefined)
    if (bearer) {
      try {
        setMcpAuthToken(s.id, bearer)
      } catch (err) {
        logger.error('Failed to store MCP auth token; refusing plaintext fallback', {
          scope: 'settings',
          serverId: s.id,
          err
        })
        throw new Error(
          `Cannot save MCP auth token for "${s.id}" to secure storage. Fix OS keychain/safeStorage and retry.`
        )
      }
    }

    const redactedEnv: Record<string, string> | undefined = safeEnv
      ? Object.fromEntries(Object.keys(safeEnv).map((k) => [k, REDACTED_VALUE]))
      : undefined
    let redactedHeaders: Record<string, string> | undefined = safeHeaders
      ? Object.fromEntries(Object.keys(safeHeaders).map((k) => [k, REDACTED_VALUE]))
      : undefined
    if (authHeader && hasMcpSecretValue(authHeader)) {
      redactedHeaders = { ...(redactedHeaders ?? {}), Authorization: REDACTED_VALUE }
    }

    const envSame =
      (redactedEnv == null && s.env == null) ||
      (redactedEnv != null &&
        s.env != null &&
        Object.keys(redactedEnv).length === Object.keys(s.env).length &&
        Object.keys(redactedEnv).every((k) => s.env![k] === redactedEnv[k]))
    const headersSame =
      (redactedHeaders == null && s.headers == null) ||
      (redactedHeaders != null &&
        s.headers != null &&
        Object.keys(redactedHeaders).length === Object.keys(s.headers).length &&
        Object.keys(redactedHeaders).every((k) => s.headers![k] === redactedHeaders![k]))

    if (envSame && headersSame) return s
    changed = true
    return {
      ...s,
      env: redactedEnv,
      headers: redactedHeaders
    }
  })

  return changed ? { ...settings, mcpServers } : settings
}

function restoreMcpSecrets(settings: Settings): Settings {
  if (!settings.mcpServers?.length) return settings

  let changed = false
  const mcpServers = settings.mcpServers.map((s) => {
    const secret = getMcpServerSecrets(s.id)
    if (!secret && !s.env && !s.headers) return s

    let nextEnv = s.env
    let nextHeaders = s.headers

    if (s.env) {
      const env: Record<string, string> = {}
      let envChanged = false
      for (const [key, value] of Object.entries(s.env)) {
        if (value === REDACTED_VALUE && secret?.env[key] && hasMcpSecretValue(secret.env[key])) {
          env[key] = secret.env[key]
          envChanged = true
        } else {
          env[key] = value
        }
      }
      if (envChanged) {
        nextEnv = env
        changed = true
      }
    }

    if (s.headers) {
      const headers: Record<string, string> = {}
      let headersChanged = false
      for (const [key, value] of Object.entries(s.headers)) {
        if (value === REDACTED_VALUE && secret?.headers[key] && hasMcpSecretValue(secret.headers[key])) {
          headers[key] = secret.headers[key]
          headersChanged = true
        } else if (
          key.toLowerCase() === 'authorization' &&
          value === REDACTED_VALUE &&
          secret?.headers.Authorization &&
          hasMcpSecretValue(secret.headers.Authorization)
        ) {
          // Case-insensitive Authorization key in secrets blob
          headers[key] = secret.headers.Authorization
          headersChanged = true
        } else {
          headers[key] = value
        }
      }
      // Also inject Authorization from secrets when settings omitted it entirely
      if (
        !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization') &&
        secret?.headers.Authorization &&
        hasMcpSecretValue(secret.headers.Authorization)
      ) {
        headers.Authorization = secret.headers.Authorization
        headersChanged = true
      }
      if (headersChanged) {
        nextHeaders = headers
        changed = true
      }
    } else if (secret?.headers.Authorization && hasMcpSecretValue(secret.headers.Authorization)) {
      nextHeaders = { Authorization: secret.headers.Authorization }
      changed = true
    }

    if (nextEnv === s.env && nextHeaders === s.headers) return s
    return { ...s, env: nextEnv, headers: nextHeaders }
  })

  return changed ? { ...settings, mcpServers } : settings
}

/** Strip env and header values before sending settings over IPC. */
export function redactSettingsForIpc(settings: Settings): Settings {
  if (!settings.mcpServers?.length) return settings
  let changed = false
  const mcpServers = settings.mcpServers.map((s) => {
    let envChanged = false
    let headerChanged = false
    const env: Record<string, string> | undefined = s.env
      ? Object.fromEntries(
          Object.entries(s.env).map(([key, value]) => {
            if (hasMcpSecretValue(value)) {
              envChanged = true
              return [key, REDACTED_VALUE]
            }
            return [key, value]
          })
        )
      : undefined
    const headers: Record<string, string> | undefined = s.headers
      ? Object.fromEntries(
          Object.entries(s.headers).map(([key, value]) => {
            if (hasMcpSecretValue(value)) {
              headerChanged = true
              return [key, REDACTED_VALUE]
            }
            return [key, value]
          })
        )
      : undefined
    if (!envChanged && !headerChanged) return s
    changed = true
    return { ...s, env, headers }
  })
  return changed ? { ...settings, mcpServers } : settings
}

/**
 * Restore secret values the renderer echoed back as `[redacted]`
 * after `redactSettingsForIpc`, so toggling MCP settings cannot wipe secrets.
 */
export function restoreRedactedMcpSecrets(
  prevServers: NonNullable<Settings['mcpServers']>,
  nextServers: NonNullable<Settings['mcpServers']>
): NonNullable<Settings['mcpServers']> {
  const prevById = new Map(prevServers.map((s) => [s.id, s]))
  return nextServers.map((server) => {
    const prior = prevById.get(server.id)
    if (!prior) return server

    const priorSecret = getMcpServerSecrets(server.id)
    let changed = false

    let nextEnv = server.env
    if (server.env && prior.env) {
      const env: Record<string, string> = { ...server.env }
      for (const [key, value] of Object.entries(env)) {
        if (value !== REDACTED_VALUE) continue
        const priorValue = prior.env[key]
        if (hasMcpSecretValue(priorValue)) {
          env[key] = priorValue
          changed = true
        } else if (priorSecret?.env[key] && hasMcpSecretValue(priorSecret.env[key])) {
          env[key] = priorSecret.env[key]
          changed = true
        }
      }
      nextEnv = env
    }

    let nextHeaders = server.headers
    if (server.headers && prior.headers) {
      const headers: Record<string, string> = { ...server.headers }
      for (const [key, value] of Object.entries(headers)) {
        if (value !== REDACTED_VALUE) continue
        const priorValue = prior.headers[key]
        if (hasMcpSecretValue(priorValue)) {
          headers[key] = priorValue
          changed = true
        } else if (priorSecret?.headers[key] && hasMcpSecretValue(priorSecret.headers[key])) {
          headers[key] = priorSecret.headers[key]
          changed = true
        }
      }
      nextHeaders = headers
    }

    if (!changed) return server
    return { ...server, env: nextEnv, headers: nextHeaders }
  })
}

/** Drop in-memory settings cache (tests / external file edits). */
export function clearSettingsCacheForTests(): void {
  settingsCache = null
}

function normalizeSettings(data: Settings): Settings {
  const host = ollamaNativeHost(data.ollamaBaseUrl)
  const custom = normalizeCustomOpenAiBaseUrl(data.customOpenAiBaseUrl)
  let next = data
  if (host !== data.ollamaBaseUrl) next = { ...next, ollamaBaseUrl: host }
  if (custom !== data.customOpenAiBaseUrl) next = { ...next, customOpenAiBaseUrl: custom }
  // SETTINGS_FORMAT_VERSION 2→3 (storage retention, audit H4/H5): an old
  // settings.json has no `storage` block — schema defaults already fill it at
  // parse ({...DEFAULT_SETTINGS, ...raw}); this guarantees the merged key and
  // fills any partially-migrated block without touching sibling settings.
  if (next.storage == null) {
    next = { ...next, storage: { ...DEFAULT_STORAGE_SETTINGS } }
  } else {
    let missing = false
    for (const key of Object.keys(DEFAULT_STORAGE_SETTINGS) as (keyof StorageSettings)[]) {
      if (next.storage[key] === undefined) missing = true
    }
    if (missing) {
      next = { ...next, storage: { ...DEFAULT_STORAGE_SETTINGS, ...next.storage } }
    }
  }
  return next
}

function stripLegacyFields(raw: Record<string, unknown>): Record<string, unknown> {
  const {
    workspacePath: _legacy,
    maxSteps: _maxSteps,
    maxAgentSteps: _maxAgentSteps,
    maxSubagentSteps: _maxSubagentSteps,
    verifyBeforeDone: _verifyBeforeDone,
    contractDoneWhen: _contractDoneWhen,
    readBeforeEdit: _readBeforeEdit,
    memoryAutoPromote: _memoryAutoPromote,
    harnessProposalRewriter: _harnessProposalRewriter,
    githubClientId: _legacyGithubClientId,
    accentPreset: _legacyAccentPreset,
    ...rest
  } = raw
  return rest
}

function persistedSettingsVersion(raw: Record<string, unknown>): number {
  return typeof raw.settingsVersion === 'number' && Number.isFinite(raw.settingsVersion)
    ? raw.settingsVersion
    : 0
}

/** Engines removed from DictationEngineSchema after v3; map to the on-device path. */
const LEGACY_DICTATION_ENGINES = new Set(['qwen3-asr', 'qwen3-asr-onnx'])

/** Local model ids that shipped only with the removed qwen3 engines. */
const LEGACY_DICTATION_MODEL_PREFIX = 'qwen3-asr'

/**
 * A persisted dictation object with a removed engine fails SettingsSchema and
 * drops the whole object back to defaults ('openai') — a silent switch from
 * local/self-hosted transcription to the cloud path. Migrate instead.
 */
function migrateRemovedDictationEngine(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value
  const dictation = { ...(value as Record<string, unknown>) }
  if (typeof dictation.engine === 'string' && LEGACY_DICTATION_ENGINES.has(dictation.engine)) {
    logger.warn('Migrated removed dictation engine to local', {
      scope: 'settings',
      code: 'SETTINGS_DICTATION_MIGRATE',
      engine: dictation.engine
    })
    dictation.engine = 'local'
  }
  if (
    typeof dictation.localModelId === 'string' &&
    dictation.localModelId.startsWith(LEGACY_DICTATION_MODEL_PREFIX)
  ) {
    dictation.localModelId = ''
  }
  // The removed qwen3 server engine stored its endpoint + bearer token inside
  // `dictation`; drop them so a stale secret cannot survive the format bump.
  delete dictation.qwen3AsrServerUrl
  delete dictation.qwen3AsrApiKey
  return dictation
}

/**
 * Rewrite old product defaults that were already written into settings.json.
 * Version is read from the raw file (not merged defaults) so a missing key
 * still runs. Exact 0.2 is the previous auto-compact default — leave any
 * other stored ratio, including a later intentional 20% after version stamp.
 */
function migratePersistedSettingsDefaults(raw: Record<string, unknown>): {
  data: Record<string, unknown>
  persist: boolean
} {
  const rawVersion = persistedSettingsVersion(raw)
  if (rawVersion >= SETTINGS_FORMAT_VERSION) {
    return { data: raw, persist: false }
  }
  const next: Record<string, unknown> = { ...raw, settingsVersion: SETTINGS_FORMAT_VERSION }
  // Only files older than v3 seeded these legacy values; a later format bump
  // must not re-run them against deliberate post-v3 choices.
  if (rawVersion < 3 && raw.autoCompactThresholdRatio === LEGACY_AUTO_COMPACT_THRESHOLD_RATIO) {
    next.autoCompactThresholdRatio = DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO
  }
  // Same contract: rewrite only the exact effort the previous format version
  // seeded; anything else (including an intentional 'medium' after this stamp)
  // is a user choice and survives.
  if (rawVersion < 3 && raw.thinkingEffort === LEGACY_THINKING_EFFORT) {
    next.thinkingEffort = DEFAULT_THINKING_EFFORT
  }
  if (rawVersion < 4) {
    next.dictation = migrateRemovedDictationEngine(next.dictation)
  }
  return { data: next, persist: true }
}

function persistSettingsOnLoad(data: Settings, reason: string): void {
  try {
    writeSettings(data)
  } catch (err) {
    logger.warn(`Failed to persist ${reason}`, {
      scope: 'settings',
      code: 'SETTINGS',
      err
    })
  }
}

/** Read legacy workspacePath from settings.json for one-time migration to workspaces.json. */
export function readLegacyWorkspacePath(): string | null {
  const p = settingsPath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const value = raw.workspacePath
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

function migrateLegacyMcpSecretsOnLoad(data: Settings): Settings {
  if (!data.mcpServers?.length) return data
  try {
    const redacted = extractAndRedactMcpSecrets(data)
    const before = JSON.stringify(data.mcpServers)
    const after = JSON.stringify(redacted.mcpServers)
    if (before !== after) {
      writeSettings(redacted)
      logger.info('Migrated legacy plaintext MCP secrets out of settings.json', {
        scope: 'settings',
        code: 'SETTINGS_MCP_MIGRATE'
      })
      return redacted
    }
    return redacted
  } catch (err) {
    logger.warn('Failed to migrate legacy MCP secrets on load; leaving disk as-is', {
      scope: 'settings',
      code: 'SETTINGS_MCP_MIGRATE',
      err
    })
    return data
  }
}

export function getSettings(): Settings {
  if (settingsCache) return restoreMcpSecrets(settingsCache)
  const p = settingsPath()
  if (!existsSync(p)) {
    settingsCache = { ...DEFAULT_SETTINGS }
    return restoreMcpSecrets(settingsCache)
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const migrated = migratePersistedSettingsDefaults(stripLegacyFields(raw))
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      ...migrated.data
    })
    if (!parsed.success) {
      logger.warn('Settings schema mismatch; merging known fields', {
        scope: 'settings',
        code: 'SETTINGS'
      })
      const merged: Settings = { ...DEFAULT_SETTINGS }
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const value = migrated.data[key]
        const field = SettingsSchema.shape[key].safeParse(value)
        if (field.success) {
          ;(merged as Record<string, unknown>)[key] = field.data
        }
      }
      settingsCache = migrateLegacyMcpSecretsOnLoad(normalizeSettings(merged))
      if (migrated.persist) persistSettingsOnLoad(settingsCache, 'migrated settings defaults')
      return restoreMcpSecrets(settingsCache)
    }
    const data = migrateLegacyMcpSecretsOnLoad(normalizeSettings(parsed.data))
    const shouldPersist =
      migrated.persist ||
      data.ollamaBaseUrl !== parsed.data.ollamaBaseUrl ||
      'workspacePath' in raw ||
      'maxSteps' in raw ||
      'maxAgentSteps' in raw ||
      'maxSubagentSteps' in raw ||
      'verifyBeforeDone' in raw ||
      'contractDoneWhen' in raw ||
      'readBeforeEdit' in raw ||
      'memoryAutoPromote' in raw ||
      'accentPreset' in raw
    if (shouldPersist) {
      persistSettingsOnLoad(
        data,
        migrated.persist
          ? 'migrated settings defaults'
          : data.ollamaBaseUrl !== parsed.data.ollamaBaseUrl
            ? 'normalized Ollama URL'
            : 'stripped legacy fields from settings'
      )
    }
    settingsCache = data
    return restoreMcpSecrets(settingsCache)
  } catch (err) {
    logger.warn('Failed to read settings', { scope: 'settings', code: 'SETTINGS', err })
    settingsCache = { ...DEFAULT_SETTINGS }
    return restoreMcpSecrets(settingsCache)
  }
}

function mcpServerIdentity(s: {
  id: string
  transport?: string
  command?: string
  url?: string
  args?: string[]
}): string {
  const transport = (s.transport ?? 'stdio').toLowerCase()
  if (transport === 'http' || transport === 'sse') {
    return `${transport}|${(s.url ?? '').trim()}`
  }
  return `stdio|${(s.command ?? '').trim()}|${(s.args ?? []).join('\0')}`
}

function mcpServerNeedsAck(s: {
  transport?: string
  command?: string
  url?: string
}): boolean {
  const transport = (s.transport ?? 'stdio').toLowerCase()
  if (transport === 'http' || transport === 'sse') return Boolean((s.url ?? '').trim())
  return Boolean((s.command ?? '').trim())
}

/** Require remoteInstallAcked when adding or changing stdio/remote MCP entries. */
function assertMcpServersAcked(
  prev: Settings,
  nextServers: NonNullable<Settings['mcpServers']>
): void {
  // Ack must come from main-only `setMarketplaceRemoteInstallAcked` — never from
  // a renderer `setSettings` partial (stripped below).
  if (prev.marketplace?.remoteInstallAcked) return
  const prevById = new Map((prev.mcpServers ?? []).map((s) => [s.id, s]))
  for (const server of nextServers) {
    if (!mcpServerNeedsAck(server)) continue
    const prior = prevById.get(server.id)
    if (!prior) {
      throw new Error(
        'Acknowledge marketplace / MCP installs in Marketplace → Manage (Package Registry) before adding MCP servers.'
      )
    }
    if (mcpServerIdentity(prior) !== mcpServerIdentity(server)) {
      throw new Error(
        'Acknowledge marketplace / MCP installs in Marketplace → Manage (Package Registry) before changing MCP server endpoints.'
      )
    }
  }
}

/**
 * Main-only writer for marketplace remote-install acknowledgement.
 * Renderer must use `marketplace:ack-remote-install` IPC — not `setSettings`.
 */
export function setMarketplaceRemoteInstallAcked(acked: boolean): Settings {
  const prev = getSettings()
  return setSettings(
    {
      marketplace: {
        registryUrl: prev.marketplace?.registryUrl ?? '',
        remoteInstallAcked: acked
      }
    },
    { allowRemoteInstallAck: true }
  )
}

export type SetSettingsOptions = {
  /**
   * Skip the remoteInstallAcked gate. Main-process only — used when syncing
   * already-installed marketplace MCP packages into settings (bundled installs
   * intentionally do not require ack; untrusted sources are gated at install).
   * Never pass from renderer IPC.
   */
  skipMcpAck?: boolean
  /**
   * Allow writing `marketplace.remoteInstallAcked`. Main-process only —
   * `setMarketplaceRemoteInstallAcked` / dedicated IPC. Renderer `setSettings`
   * strips this field.
   */
  allowRemoteInstallAck?: boolean
}

/**
 * Merge a partial into the latest settings and persist.
 * Always re-reads the in-memory cache so concurrent IPC partials compose
 * (last writer still wins for the same key, but distinct keys are not dropped
 * when callers use setSettings(partial) rather than get→mutate→write).
 *
 * Sync RMW is atomic on the main-process event loop; use `enqueueSettingsMutation`
 * when an async caller must await between read and write of derived state.
 */
export function setSettings(
  partial: Partial<Settings>,
  opts?: SetSettingsOptions
): Settings {
  const prev = getSettings()
  // Strip renderer-writable ack unless main explicitly allows it.
  // Changing registryUrl clears ack so a new endpoint cannot reuse a prior consent.
  let marketplace = partial.marketplace
  if (marketplace !== undefined && !opts?.allowRemoteInstallAck) {
    const { remoteInstallAcked: _ignored, ...rest } = marketplace
    const prevUrl = (prev.marketplace?.registryUrl ?? '').trim()
    const nextUrl =
      rest.registryUrl !== undefined ? rest.registryUrl.trim() : prevUrl
    const urlChanged = rest.registryUrl !== undefined && nextUrl !== prevUrl
    marketplace = {
      ...rest,
      remoteInstallAcked: urlChanged
        ? false
        : (prev.marketplace?.remoteInstallAcked ?? false)
    }
  }
  let mcpServers = partial.mcpServers
  if (mcpServers !== undefined) {
    mcpServers = restoreRedactedMcpSecrets(prev.mcpServers ?? [], mcpServers)
    if (!opts?.skipMcpAck) {
      assertMcpServersAcked(prev, mcpServers)
    }
  }
  let codeIndex = partial.codeIndex
  if (codeIndex !== undefined) {
    codeIndex = { ...prev.codeIndex, ...codeIndex }
  }
  let dictation = partial.dictation
  if (dictation !== undefined) {
    dictation = { ...prev.dictation, ...dictation }
  }
  let notifications = partial.notifications
  if (notifications !== undefined) {
    notifications = { ...prev.notifications, ...notifications }
  }
  let storage = partial.storage
  if (storage !== undefined) {
    storage = { ...prev.storage, ...storage }
  }
  const merged = {
    ...prev,
    ...partial,
    ...(marketplace !== undefined ? { marketplace } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(codeIndex !== undefined ? { codeIndex } : {}),
    ...(dictation !== undefined ? { dictation } : {}),
    ...(notifications !== undefined ? { notifications } : {}),
    ...(storage !== undefined ? { storage } : {})
  }
  // Gate the incoming patch at the write boundary so a mangled base URL paste
  // can never be persisted (2026-09 settings audit). Already-persisted legacy
  // garbage is not re-gated here (it would brick unrelated updates); the
  // normalize calls below repair it to the safe defaults.
  if (partial.ollamaBaseUrl !== undefined) {
    const check = validateOllamaBaseUrl(partial.ollamaBaseUrl)
    if (!check.ok) throw new Error(check.error)
  }
  if (partial.customOpenAiBaseUrl !== undefined) {
    const check = validateCustomOpenAiBaseUrl(partial.customOpenAiBaseUrl)
    if (!check.ok) throw new Error(check.error)
  }
  if (typeof merged.ollamaBaseUrl === 'string') {
    merged.ollamaBaseUrl = ollamaNativeHost(merged.ollamaBaseUrl)
  }
  if (typeof merged.customOpenAiBaseUrl === 'string') {
    merged.customOpenAiBaseUrl = normalizeCustomOpenAiBaseUrl(merged.customOpenAiBaseUrl)
  }
  if (partial.mcpServers !== undefined) {
    const hasGoogle = (merged.mcpServers ?? []).some((s) => isGoogleMcpId(s.id))
    if (!hasGoogle) merged.googleMcpClientId = ''
  }
  if (partial.provider !== undefined && partial.model === undefined) {
    merged.model = defaultModelFor(partial.provider)
  }
  const next = extractAndRedactMcpSecrets(SettingsSchema.parse(merged))
  try {
    writeSettings(next)
  } catch (err) {
    logger.error('Failed to write settings', { scope: 'settings', code: 'SETTINGS', err })
    throw err
  }
  const prevEmbedder = prev.codeIndex?.embedder ?? 'mdenseon'
  const nextEmbedder = next.codeIndex?.embedder ?? 'mdenseon'
  if (partial.codeIndex !== undefined && prevEmbedder !== nextEmbedder) {
    try {
      // Lazy require avoids circular import with codeindex → settings.
      const { closeCodeIndex, clearMDenseOnSession, clearLfm2LlamaCppCache } = require('../agent/codeindex') as {
        closeCodeIndex: (workspaceRoot?: string) => void
        clearMDenseOnSession: () => void
        clearLfm2LlamaCppCache: () => void
      }
      closeCodeIndex()
      clearMDenseOnSession()
      clearLfm2LlamaCppCache()
    } catch {
      // ignore if codeindex unavailable in early boot / tests without electron
    }
  }
  if (partial.mcpServers !== undefined) {
    const nextIds = new Set((next.mcpServers ?? []).map((s) => s.id))
    for (const s of prev.mcpServers ?? []) {
      if (!nextIds.has(s.id)) {
        try {
          clearMcpAuthToken(s.id)
          clearMcpOAuthState(s.id)
          clearMcpServerSecrets(s.id)
          clearMcpOAuthClientSecret(s.id)
        } catch {
          // best-effort orphan cleanup
        }
      }
    }
    if (!(next.mcpServers ?? []).some((s) => isGoogleMcpId(s.id))) {
      try {
        if (hasGoogleMcpClientSecret()) clearGoogleMcpClientSecret()
      } catch {
        // best-effort
      }
    }
    try {
      // Lazy require avoids circular import with marketplace/resolve → settings.
      const { invalidateMcpResolveCache } = require('../marketplace/resolve') as {
        invalidateMcpResolveCache: () => void
      }
      invalidateMcpResolveCache()
    } catch {
      // ignore if resolve module unavailable in early boot
    }
  }
  return next
}
