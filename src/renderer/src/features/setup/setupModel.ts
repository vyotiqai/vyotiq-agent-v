import type { IpcResult, ListModelsResult, Settings } from '@shared/ipc'
import { isProviderConfigured, providerLabel } from '@shared/providers'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { isModelListUnsupportedWarning } from '@renderer/features/chat/components/composer/composerModelUtils'

export type SetupProviderSettings = Pick<Settings, 'provider' | 'ollamaBaseUrl' | 'customOpenAiBaseUrl' | 'customProviders'>

/** What asking the provider for its models said: it answered, or why it didn't. */
export type ProviderCheck = { state: 'checking' } | { state: 'ok' } | { state: 'failed'; reason: string }

export type SetupProvider = {
  /** True when the agent can use this provider now: it has what it needs, and it answered. */
  ready: boolean
  state: 'done' | 'missing_key' | 'checking' | 'failed'
  label: string
  /** "key saved, encrypted on this device" · "no key needed · http://127.0.0.1:11434" · "needs an API key". */
  detail: string
  /** Main's own words for why the provider didn't answer. */
  reason?: string
}

/** The host a provider with a configurable address talks to. */
function providerHost(settings: SetupProviderSettings): string | undefined {
  if (settings.provider === 'ollama') return settings.ollamaBaseUrl
  if (settings.provider === 'custom') return settings.customOpenAiBaseUrl
  return undefined
}

/** True when the provider has a saved key, or its host needs none. */
export function providerConfigured(settings: SetupProviderSettings, secrets: Record<string, boolean>): boolean {
  return isProviderConfigured(settings.provider, secrets, {
    ollamaBaseUrl: settings.ollamaBaseUrl,
    customOpenAiBaseUrl: settings.customOpenAiBaseUrl,
    customProviders: settings.customProviders
  })
}

/**
 * A model list read as a connection check. Main answers with placeholder
 * models and a warning when it could not reach the provider, so any warning
 * means no — except a reachable host that simply serves no list, which chat
 * can still use (the composer lets that one send, too).
 */
export function providerCheckFrom(res: IpcResult<ListModelsResult>): ProviderCheck {
  if (!res.ok) return { state: 'failed', reason: res.error }
  const warning = res.data.warning?.trim()
  if (!warning || isModelListUnsupportedWarning(warning)) return { state: 'ok' }
  // The tail about placeholder models is for the model picker, not for here.
  const reason = warning.replace(/[\s;,—-]*\bshowing (?:illustrative placeholder model IDs|seed defaults)[\s\S]*$/i, '')
  return { state: 'failed', reason: reason || warning }
}

/**
 * Step 1 of Set up, from the saved settings, the key store and a live check.
 * A key only counts as saved when it decrypts with this machine's OS keychain
 * — the store never writes one unencrypted — so "encrypted on this device" is
 * always true of a saved key. Having a key, or a host that needs none, is not
 * the same as a provider that answers; the step is done only once it has.
 */
export function setupProvider(
  settings: SetupProviderSettings,
  secrets: Record<string, boolean>,
  check: ProviderCheck | null
): SetupProvider {
  const { provider } = settings
  const label = providerLabel(provider, settings.customProviders)
  if (!providerConfigured(settings, secrets)) {
    return { ready: false, state: 'missing_key', label, detail: 'needs an API key' }
  }
  const host = providerHost(settings)
  if (check == null || check.state === 'checking') {
    return { ready: false, state: 'checking', label, detail: host ? `checking ${host}…` : 'checking…' }
  }
  if (check.state === 'failed') {
    return { ready: false, state: 'failed', label, detail: 'not connected', reason: check.reason }
  }
  if (secrets[provider]) return { ready: true, state: 'done', label, detail: 'key saved, encrypted on this device' }
  return { ready: true, state: 'done', label, detail: host ? `no key needed · ${host}` : 'no key needed' }
}

/**
 * The folder Set up counts as opened: the one in front, else another open
 * one — never the app's own scratch folder, which main opens by itself
 * whenever no project is open. Nobody chose that one.
 */
export function setupWorkspace(
  activePath: string | null,
  openPaths: readonly string[],
  scratchPath: string | null
): string | null {
  const chosen = (path: string): boolean => scratchPath == null || !workspacePathsEqual(path, scratchPath)
  if (activePath && chosen(activePath)) return activePath
  return openPaths.find(chosen) ?? null
}

/** Folders opened before, most recent first, without the open ones or the scratch folder. */
export function setupRecents(
  recentPaths: readonly string[],
  openPaths: readonly string[],
  scratchPath: string | null,
  limit = 5
): string[] {
  const skip = scratchPath ? [...openPaths, scratchPath] : openPaths
  return recentPaths.filter((path) => !skip.some((open) => workspacePathsEqual(open, path))).slice(0, limit)
}

/**
 * Set up shows on a first run: until "Start your first task" records the
 * approval choice, and only while no task exists — someone who dismissed the
 * approval question and already has tasks goes straight to Home.
 */
export function needsSetup(onboardingDone: boolean, taskCount: number): boolean {
  return !onboardingDone && taskCount === 0
}
