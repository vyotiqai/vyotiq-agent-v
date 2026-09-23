import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  SECRET_PROVIDERS,
  type ProviderId,
  type SecretProvider,
  type Settings,
  type ToolApprovalSettings,
  type WorkspaceSettingsOverride,
  DEFAULT_TOOL_APPROVAL
} from '@shared/ipc'
import {
  PROVIDER_DEFAULTS,
  defaultModelFor,
  providerLabel,
  validateCustomOpenAiBaseUrl,
  validateOllamaBaseUrl,
  providerNeedsKey,
  isLocalOllamaHost,
  isOllamaCloudHost,
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_LOCAL_DEFAULT
} from '@shared/providers'
import { findByWorkspacePath } from '@shared/workspacePathMatch'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { useModelCatalog } from '@renderer/lib/hooks/useModelCatalog'
import type { SettingsErrorField, SettingsSection, SettingsViewProps } from '../types'
import { SETTINGS_ERROR_IDS } from '../constants'
import { defaultKeyProvider } from '../utils/settingsHelpers'

export type AgentSettingsPatch = Partial<
  Pick<
    WorkspaceSettingsOverride,
    | 'keepRecentTurns'
    | 'autoCompactThresholdRatio'
    | 'toolApproval'
    | 'showThinking'
    | 'thinkingEnabled'
    | 'thinkingEffort'
    | 'agentPersona'
    | 'agentTone'
    | 'agentIdentity'
    | 'responseLanguage'
    | 'responseVerbosity'
  >
>

export type SettingsFormState = ReturnType<typeof useSettingsForm>

export function useSettingsForm({
  settings,
  secrets,
  encryptionAvailable = true,
  appError = null,
  onDismissAppError,
  onClose,
  onUpdate,
  onSaveSecret,
  onClearSecret,
  onModelsRefreshed,
  activeWorkspacePath = null,
  settingsOverridesByPath = {},
  effectiveChatSettings,
  onSetSettingsOverride,
  section: sectionProp,
  onSectionChange: onSectionChangeProp
}: SettingsViewProps) {
  const [internalSection, setInternalSection] = useState<SettingsSection>('general')
  const section = sectionProp ?? internalSection
  const onSectionChange = onSectionChangeProp ?? setInternalSection
  const [keyProvider, setKeyProvider] = useState<SecretProvider>(() =>
    defaultKeyProvider(settings.provider, secrets)
  )
  const [keyDraft, setKeyDraft] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaBaseUrl)
  const [customUrl, setCustomUrl] = useState(settings.customOpenAiBaseUrl)
  // Persona & style drafts (Settings → Agent). Same draft-then-commit pattern
  // as the URL fields: edits stay local until blur, and unmount flushes.
  // Persisted values are mirrored locally so a re-blur right after a save
  // doesn't re-fire before the parent settings propagate.
  const derivedPersona = effectiveChatSettings?.agentPersona ?? settings.agentPersona ?? ''
  const [personaPersisted, setPersonaPersisted] = useState(derivedPersona)
  const [personaDraft, setPersonaDraft] = useState(derivedPersona)
  const derivedTone = effectiveChatSettings?.agentTone ?? settings.agentTone ?? ''
  const [tonePersisted, setTonePersisted] = useState(derivedTone)
  const [toneDraft, setToneDraft] = useState(derivedTone)
  const derivedIdentity =
    effectiveChatSettings?.agentIdentity ?? settings.agentIdentity ?? ''
  const [identityPersisted, setIdentityPersisted] = useState(derivedIdentity)
  const [identityDraft, setIdentityDraft] = useState(derivedIdentity)
  const derivedLanguage =
    effectiveChatSettings?.responseLanguage ?? settings.responseLanguage ?? ''
  const [languagePersisted, setLanguagePersisted] = useState(derivedLanguage)
  const [languageDraft, setLanguageDraft] = useState(derivedLanguage)
  const [error, setError] = useState<string | null>(null)
  const [errorField, setErrorField] = useState<SettingsErrorField>(null)
  const [modelsInfo, setModelsInfo] = useState<string | null>(null)
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [clearingKey, setClearingKey] = useState(false)
  const [savingField, setSavingField] = useState(false)

  const clearErrors = (): void => {
    setError(null)
    setErrorField(null)
    onDismissAppError?.()
  }

  const setFieldError = (field: SettingsErrorField, message: string): void => {
    setErrorField(field)
    setError(message)
  }

  const displayError = error ?? appError

  type SettingsErrorKey = Exclude<SettingsErrorField, null>
  const fieldError = useMemo<Partial<Record<SettingsErrorKey, ReactNode>>>(() => {
    if (!errorField || !displayError) return {}
    const id = SETTINGS_ERROR_IDS[errorField]
    if (!id) return {}
    return {
      [errorField]: (
        <p id={id} className="m-0 w-full text-xs text-danger" role="alert">
          {displayError}
        </p>
      )
    } as Partial<Record<SettingsErrorKey, ReactNode>>
  }, [errorField, displayError])

  const runUpdate = async (partial: Partial<Settings>): Promise<boolean> => {
    clearErrors()
    setModelsInfo(null)
    setSavingField(true)
    try {
      const res = await onUpdate(partial)
      if (!res.ok) {
        setError(res.error)
        return false
      }
      return true
    } finally {
      setSavingField(false)
    }
  }

  /**
   * Workspace-overridable fields write to the active workspace override when
   * override is on; otherwise they update global settings.
   */
  const runAgentUpdate = async (patch: AgentSettingsPatch): Promise<boolean> => {
    // Mirror the composer's persistence contract: a thinking toggle also
    // updates the per-provider prefs map that setActiveProvider restores from.
    // Writing only the top-level fields made a Settings-only toggle revert
    // itself when the user switched provider away and back.
    const prefsProvider = effectiveChatSettings?.provider ?? settings.provider
    const prefsPartial =
      patch.thinkingEnabled !== undefined || patch.thinkingEffort !== undefined
        ? (() => {
            const currentPrefs =
              settings.thinkingPrefsByProvider[prefsProvider] ?? {
                thinkingEnabled: settings.thinkingEnabled,
                thinkingEffort: settings.thinkingEffort
              }
            return {
              thinkingPrefsByProvider: {
                ...settings.thinkingPrefsByProvider,
                [prefsProvider]: {
                  thinkingEnabled: patch.thinkingEnabled ?? currentPrefs.thinkingEnabled,
                  thinkingEffort: patch.thinkingEffort ?? currentPrefs.thinkingEffort
                }
              }
            }
          })()
        : undefined
    if (workspaceOverrideActive && activeWorkspacePath && onSetSettingsOverride) {
      clearErrors()
      setModelsInfo(null)
      setSavingField(true)
      try {
        const current =
          findByWorkspacePath(settingsOverridesByPath, activeWorkspacePath) ?? undefined
        const res = await onSetSettingsOverride(activeWorkspacePath, {
          ...current,
          useOverride: true,
          ...patch
        })
        if (!res.ok) {
          setError(res.error)
          return false
        }
        // thinkingPrefsByProvider is global-only (not part of the override
        // schema) — write it to global settings like the composer path does.
        if (prefsPartial) void runUpdate(prefsPartial)
        return true
      } finally {
        setSavingField(false)
      }
    }
    return runUpdate(prefsPartial ? { ...patch, ...prefsPartial } : patch)
  }

  /** Trim-on-save commit for the Persona draft; reverts the field on failure. */
  const persistPersona = async (): Promise<boolean> => {
    const next = personaDraft.trim()
    if (next !== personaDraft) setPersonaDraft(next)
    if (next === personaPersisted) return true
    const ok = await runAgentUpdate({ agentPersona: next })
    if (ok) setPersonaPersisted(next)
    else setPersonaDraft(personaPersisted)
    return ok
  }

  /** Trim-on-save commit for the Tone draft; reverts the field on failure. */
  const persistTone = async (): Promise<boolean> => {
    const next = toneDraft.trim()
    if (next !== toneDraft) setToneDraft(next)
    if (next === tonePersisted) return true
    const ok = await runAgentUpdate({ agentTone: next })
    if (ok) setTonePersisted(next)
    else setToneDraft(tonePersisted)
    return ok
  }

  /** Trim-on-save commit for the Identity draft; reverts the field on failure. */
  const persistIdentity = async (): Promise<boolean> => {
    const next = identityDraft.trim()
    if (next !== identityDraft) setIdentityDraft(next)
    if (next === identityPersisted) return true
    const ok = await runAgentUpdate({ agentIdentity: next })
    if (ok) setIdentityPersisted(next)
    else setIdentityDraft(identityPersisted)
    return ok
  }

  /** Trim-on-save commit for the Response language draft; reverts on failure. */
  const persistLanguage = async (): Promise<boolean> => {
    const next = languageDraft.trim()
    if (next !== languageDraft) setLanguageDraft(next)
    if (next === languagePersisted) return true
    const ok = await runAgentUpdate({ responseLanguage: next })
    if (ok) setLanguagePersisted(next)
    else setLanguageDraft(languagePersisted)
    return ok
  }

  const providerMeta = PROVIDER_DEFAULTS.find((p) => p.id === settings.provider)
  const displayProvider = effectiveChatSettings?.provider ?? settings.provider
  const displayModel = effectiveChatSettings?.model ?? settings.model
  const displayProviderMeta = PROVIDER_DEFAULTS.find((p) => p.id === displayProvider)
  const workspaceOverrideActive = Boolean(
    activeWorkspacePath &&
      findByWorkspacePath(settingsOverridesByPath, activeWorkspacePath)?.useOverride
  )
  const keyHasSaved = Boolean(secrets[keyProvider])
  const keyProviderLabel = providerLabel(keyProvider)
  const busy = savingKey || clearingKey || savingField || refreshingModels
  const formLocked = savingKey || clearingKey || savingField
  const activeNeedsKey = (() => {
    if (settings.provider === 'ollama') {
      if (secrets.ollama) return false
      return providerNeedsKey(
        'ollama',
        (workspaceOverrideActive ? effectiveChatSettings?.ollamaBaseUrl : undefined) ??
          settings.ollamaBaseUrl
      )
    }
    if (settings.provider === 'custom') {
      if (secrets.custom) return false
      return providerNeedsKey(
        'custom',
        (workspaceOverrideActive ? effectiveChatSettings?.customOpenAiBaseUrl : undefined) ??
          (customUrl || settings.customOpenAiBaseUrl)
      )
    }
    return !secrets[settings.provider as SecretProvider]
  })()
  const savedKeyProviders = useMemo(
    () => SECRET_PROVIDERS.filter((p) => secrets[p]),
    [secrets]
  )
  const { refresh: refreshCatalog } = useModelCatalog(
    settings.provider,
    {
      ollamaBaseUrl:
        (workspaceOverrideActive ? effectiveChatSettings?.ollamaBaseUrl : undefined) ??
        settings.ollamaBaseUrl,
      customOpenAiBaseUrl:
        (workspaceOverrideActive ? effectiveChatSettings?.customOpenAiBaseUrl : undefined) ??
        settings.customOpenAiBaseUrl
    },
    undefined,
    false
  )

  useEffect(() => {
    setOllamaUrl(settings.ollamaBaseUrl)
  }, [settings.ollamaBaseUrl])

  useEffect(() => {
    setCustomUrl(settings.customOpenAiBaseUrl)
  }, [settings.customOpenAiBaseUrl])

  useEffect(() => {
    setPersonaPersisted(derivedPersona)
    setPersonaDraft(derivedPersona)
  }, [derivedPersona])

  useEffect(() => {
    setTonePersisted(derivedTone)
    setToneDraft(derivedTone)
  }, [derivedTone])

  useEffect(() => {
    setIdentityPersisted(derivedIdentity)
    setIdentityDraft(derivedIdentity)
  }, [derivedIdentity])

  useEffect(() => {
    setLanguagePersisted(derivedLanguage)
    setLanguageDraft(derivedLanguage)
  }, [derivedLanguage])

  useEffect(() => {
    setKeyProvider(settings.provider)
  }, [settings.provider])

  useEscapeToClose(onClose, true, { deferToMenus: true })

  const savedKeyCount = useMemo(
    () => SECRET_PROVIDERS.filter((p) => secrets[p]).length,
    [secrets]
  )

  const toolApproval: ToolApprovalSettings =
    (workspaceOverrideActive ? effectiveChatSettings?.toolApproval : undefined) ??
    settings.toolApproval ??
    DEFAULT_TOOL_APPROVAL

  const agentKeepRecentTurns =
    (workspaceOverrideActive ? effectiveChatSettings?.keepRecentTurns : undefined) ??
    settings.keepRecentTurns

  const agentAutoCompactThresholdPct = Math.round(
    ((workspaceOverrideActive
      ? effectiveChatSettings?.autoCompactThresholdRatio
      : undefined) ??
      settings.autoCompactThresholdRatio) * 100
  )

  const selectKeyProvider = (provider: SecretProvider): void => {
    setKeyProvider(provider)
    setKeyDraft('')
  }

  const setActiveProvider = async (provider: ProviderId): Promise<boolean> => {
    setKeyProvider(provider)
    setKeyDraft('')
    if (provider === settings.provider) return true
    const prefs = settings.thinkingPrefsByProvider[provider] ?? {
      thinkingEnabled: settings.thinkingEnabled,
      thinkingEffort: settings.thinkingEffort
    }
    const ok = await runUpdate({
      provider,
      model: defaultModelFor(provider),
      thinkingEnabled: prefs.thinkingEnabled,
      thinkingEffort: prefs.thinkingEffort
    })
    if (!ok) return false
    setModelsInfo(`Active provider set to ${providerLabel(provider)}.`)
    return true
  }

  const commitOllamaUrl = async (): Promise<string | null> => {
    const parsed = validateOllamaBaseUrl(ollamaUrl)
    if (!parsed.ok) {
      setOllamaUrl(settings.ollamaBaseUrl)
      setFieldError('ollama', parsed.error)
      return null
    }
    const normalized = parsed.url
    if (normalized !== ollamaUrl) setOllamaUrl(normalized)
    if (normalized === settings.ollamaBaseUrl) return normalized
    const ok = await runUpdate({ ollamaBaseUrl: normalized })
    if (!ok) {
      setOllamaUrl(settings.ollamaBaseUrl)
      return null
    }
    return normalized
  }

  const commitCustomUrl = async (): Promise<string | null> => {
    const parsed = validateCustomOpenAiBaseUrl(customUrl)
    if (!parsed.ok) {
      setCustomUrl(settings.customOpenAiBaseUrl)
      setFieldError('customUrl', parsed.error)
      return null
    }
    const normalized = parsed.url
    if (normalized !== customUrl) setCustomUrl(normalized)
    if (normalized === settings.customOpenAiBaseUrl) return normalized
    const ok = await runUpdate({ customOpenAiBaseUrl: normalized })
    if (!ok) {
      setCustomUrl(settings.customOpenAiBaseUrl)
      return null
    }
    return normalized
  }

  const refreshModels = async (
    provider = settings.provider,
    opts?: { skipKeyCheck?: boolean }
  ): Promise<void> => {
    clearErrors()
    setModelsInfo(null)
    setRefreshingModels(true)
    try {
      const effectiveOllama =
        workspaceOverrideActive && effectiveChatSettings?.ollamaBaseUrl
          ? effectiveChatSettings.ollamaBaseUrl
          : undefined
      const effectiveCustom =
        workspaceOverrideActive && effectiveChatSettings?.customOpenAiBaseUrl
          ? effectiveChatSettings.customOpenAiBaseUrl
          : undefined
      const baseForKeyCheck =
        provider === 'ollama'
          ? effectiveOllama ?? ollamaUrl
          : provider === 'custom'
            ? effectiveCustom ?? customUrl
            : undefined
      if (providerNeedsKey(provider, baseForKeyCheck) && !opts?.skipKeyCheck) {
        const hasKey = Boolean(secrets[provider as SecretProvider])
        if (!hasKey) {
          const label = providerLabel(provider)
          setModelsInfo(`Seed catalog for ${label} (API key missing)`)
          setError(
            `${label} API key not set. Save a ${label} key below, then refresh.`
          )
          return
        }
      }

      let ollamaHost: string | undefined
      let customHost: string | undefined
      if (provider === 'ollama') {
        if (effectiveOllama) {
          // Saved/override value bypasses the field commit — still validate so
          // a bad host errors here instead of failing catalog/chat against a
          // host the user never entered.
          const parsed = validateOllamaBaseUrl(effectiveOllama)
          if (!parsed.ok) {
            setError(`Saved ${parsed.error} — fix it in Settings, then refresh.`)
            return
          }
          ollamaHost = parsed.url
        } else {
          const host = await commitOllamaUrl()
          if (!host) return
          ollamaHost = host
        }
      }
      if (provider === 'custom') {
        if (effectiveCustom) {
          const parsed = validateCustomOpenAiBaseUrl(effectiveCustom)
          if (!parsed.ok) {
            setError(`Saved ${parsed.error} — fix it in Settings, then refresh.`)
            return
          }
          customHost = parsed.url
        } else {
          const host = await commitCustomUrl()
          if (!host) return
          customHost = host
        }
      }
      const res = await refreshCatalog({
        forceRefresh: true,
        provider,
        ollamaBaseUrl: ollamaHost,
        customOpenAiBaseUrl: customHost
      })
      if (res.ok) {
        onModelsRefreshed?.()
        const label = providerLabel(provider)
        if (res.warning) {
          setModelsInfo(
            `${res.models.length} seed models for ${label} (live catalog unavailable): ${res.warning}`
          )
        } else {
          setModelsInfo(`${res.models.length} models for ${label}`)
        }
      } else {
        setError(res.error)
      }
    } finally {
      setRefreshingModels(false)
    }
  }

  const saveKey = async (): Promise<void> => {
    let value = keyDraft.trim()
    if (!value) {
      setFieldError('apikey', 'API key cannot be empty.')
      return
    }
    clearErrors()
    setModelsInfo(null)
    setSavingKey(true)
    try {
      const res = await onSaveSecret(keyProvider, value)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setKeyDraft('')
      // Ollama API keys target Cloud — switch off local default automatically.
      if (keyProvider === 'ollama' && isLocalOllamaHost(ollamaUrl || settings.ollamaBaseUrl)) {
        const ok = await runUpdate({ ollamaBaseUrl: OLLAMA_CLOUD_BASE_URL })
        if (ok) setOllamaUrl(OLLAMA_CLOUD_BASE_URL)
      }
      setModelsInfo(`Saved ${keyProviderLabel} key.`)
      await refreshModels(keyProvider as ProviderId, { skipKeyCheck: true })
    } finally {
      setSavingKey(false)
    }
  }

  const clearKey = async (onClearSecret: SettingsViewProps['onClearSecret']): Promise<void> => {
    clearErrors()
    setModelsInfo(null)
    setClearingKey(true)
    try {
      const res = await onClearSecret(keyProvider)
      if (!res.ok) setError(res.error)
      else {
        setKeyDraft('')
        if (keyProvider === 'ollama' && isOllamaCloudHost(ollamaUrl || settings.ollamaBaseUrl)) {
          const ok = await runUpdate({ ollamaBaseUrl: OLLAMA_LOCAL_DEFAULT })
          if (ok) setOllamaUrl(OLLAMA_LOCAL_DEFAULT)
        }
        setModelsInfo(`Cleared ${keyProviderLabel} key.`)
      }
    } finally {
      setClearingKey(false)
    }
  }

  const navigateSection = (id: SettingsSection): void => {
    onSectionChange(id)
    clearErrors()
    setModelsInfo(null)
  }

  // Closing settings must not silently drop uncommitted URL drafts: flush the
  // ones that are valid and changed on unmount, leave invalid drafts alone.
  const flushUrlDraftsRef = useRef<() => void>(() => {})
  flushUrlDraftsRef.current = () => {
    const ollama = validateOllamaBaseUrl(ollamaUrl)
    if (ollama.ok && ollama.url !== settings.ollamaBaseUrl) {
      void runUpdate({ ollamaBaseUrl: ollama.url })
    }
    const custom = validateCustomOpenAiBaseUrl(customUrl)
    if (custom.ok && custom.url !== settings.customOpenAiBaseUrl) {
      void runUpdate({ customOpenAiBaseUrl: custom.url })
    }
  }
  useEffect(() => {
    return () => flushUrlDraftsRef.current()
  }, [])

  // Closing Settings must not silently drop uncommitted persona/tone/language
  // text: flush the changed (trimmed) value on unmount. Trim-on-save keeps
  // edge whitespace out of the prompt even when the user never blurs.
  // One write for every changed draft: an override save resends the whole
  // override as it was at render, so a second concurrent save would put back
  // the field the first one had just changed.
  const flushPersonaToneRef = useRef<() => void>(() => {})
  flushPersonaToneRef.current = () => {
    const patch: AgentSettingsPatch = {}
    const persona = personaDraft.trim()
    if (persona !== personaPersisted) patch.agentPersona = persona
    const tone = toneDraft.trim()
    if (tone !== tonePersisted) patch.agentTone = tone
    const identity = identityDraft.trim()
    if (identity !== identityPersisted) patch.agentIdentity = identity
    const language = languageDraft.trim()
    if (language !== languagePersisted) patch.responseLanguage = language
    if (Object.keys(patch).length > 0) void runAgentUpdate(patch)
  }
  useEffect(() => {
    return () => flushPersonaToneRef.current()
  }, [])

  const setErrorMessage = (message: string): void => {
    setError(message)
  }

  return {
    section,
    navigateSection,
    settings,
    keyProvider,
    keyDraft,
    setKeyDraft,
    personaDraft,
    setPersonaDraft,
    persistPersona,
    personaDirty: personaDraft !== personaPersisted,
    toneDraft,
    setToneDraft,
    persistTone,
    toneDirty: toneDraft !== tonePersisted,
    identityDraft,
    setIdentityDraft,
    persistIdentity,
    identityDirty: identityDraft !== identityPersisted,
    languageDraft,
    setLanguageDraft,
    persistLanguage,
    languageDirty: languageDraft !== languagePersisted,
    ollamaUrl,
    setOllamaUrl,
    customUrl,
    setCustomUrl,
    error,
    errorField,
    modelsInfo,
    setModelsInfo,
    refreshingModels,
    savingKey,
    clearingKey,
    savingField,
    clearErrors,
    setFieldError,
    displayError,
    fieldError,
    providerMeta,
    displayProvider,
    displayModel,
    displayProviderMeta,
    workspaceOverrideActive,
    activeWorkspacePath,
    effectiveChatSettings,
    keyHasSaved,
    keyProviderLabel,
    busy,
    formLocked,
    activeNeedsKey,
    savedKeyProviders,
    savedKeyCount,
    toolApproval,
    agentKeepRecentTurns,
    agentAutoCompactThresholdPct,
    encryptionAvailable,
    runUpdate,
    runAgentUpdate,
    selectKeyProvider,
    setActiveProvider,
    commitOllamaUrl,
    commitCustomUrl,
    refreshModels,
    saveKey,
    clearKey,
    setErrorMessage
  }
}
