import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, SecretProvider, Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  defaultModelFor,
  validateCustomOpenAiBaseUrl,
  providerLabel,
  providerOptionsForConfigured
} from '@shared/providers'
import { Input, Menu } from '@renderer/lib/ui'
import { workspaceShort } from '../utils/settingsHelpers'

export function WorkspaceOverrideCard({
  path,
  isActive,
  globalSettings,
  secrets,
  override,
  disabled,
  onSetOverride,
  onOverrideError
}: {
  path: string
  isActive: boolean
  globalSettings: Settings
  secrets: Record<SecretProvider, boolean>
  override: WorkspaceSettingsOverride | undefined
  disabled?: boolean
  onSetOverride: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onOverrideError?: (message: string) => void
}) {
  const useOverride = Boolean(override?.useOverride)
  const [provider, setProvider] = useState(override?.provider ?? globalSettings.provider)
  const [model, setModel] = useState(override?.model ?? globalSettings.model)
  const [customUrl, setCustomUrl] = useState(
    override?.customOpenAiBaseUrl ?? globalSettings.customOpenAiBaseUrl ?? CUSTOM_OPENAI_DEFAULT
  )
  const providerOptions = useMemo(
    () =>
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: globalSettings.ollamaBaseUrl,
        customOpenAiBaseUrl: globalSettings.customOpenAiBaseUrl,
        alwaysInclude: [provider]
      }),
    [
      secrets,
      globalSettings.ollamaBaseUrl,
      globalSettings.customOpenAiBaseUrl,
      provider
    ]
  )

  useEffect(() => {
    setProvider(override?.provider ?? globalSettings.provider)
    setModel(override?.model ?? globalSettings.model)
    setCustomUrl(
      override?.customOpenAiBaseUrl ?? globalSettings.customOpenAiBaseUrl ?? CUSTOM_OPENAI_DEFAULT
    )
  }, [
    override?.provider,
    override?.model,
    override?.customOpenAiBaseUrl,
    globalSettings.provider,
    globalSettings.model,
    globalSettings.customOpenAiBaseUrl
  ])

  const persist = async (patch: Partial<WorkspaceSettingsOverride>): Promise<void> => {
    const res = await onSetOverride(path, {
      ...override,
      useOverride: true,
      provider: patch.provider ?? provider,
      model: patch.model ?? model,
      ...patch
    })
    if (!res.ok) onOverrideError?.(res.error)
  }

  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-sm tracking-[var(--vy-tracking)] text-fg-strong">
            {workspaceShort(path)}
            {isActive ? <span className="ml-1.5 text-xs text-muted">· active</span> : null}
          </p>
          <p className="m-0 mt-0.5 truncate text-xs text-secondary" title={path}>
            {path}
          </p>
        </div>
        <label className="inline-flex shrink-0 items-center gap-1.5 text-xs text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            aria-label={`Use custom settings for ${workspaceShort(path)}`}
            disabled={disabled}
            checked={useOverride}
            onChange={(e) => {
              if (e.target.checked) {
                void onSetOverride(path, {
                  useOverride: true,
                  provider: globalSettings.provider,
                  model: globalSettings.model,
                  customOpenAiBaseUrl: globalSettings.customOpenAiBaseUrl,
                  thinkingEnabled: globalSettings.thinkingEnabled,
                  thinkingEffort: globalSettings.thinkingEffort,
                  showThinking: globalSettings.showThinking,
                  keepRecentTurns: globalSettings.keepRecentTurns,
                  autoCompactThresholdRatio: globalSettings.autoCompactThresholdRatio,
                  toolApproval: globalSettings.toolApproval,
                  agentPersona: globalSettings.agentPersona,
                  agentIdentity: globalSettings.agentIdentity,
                  agentTone: globalSettings.agentTone,
                  responseLanguage: globalSettings.responseLanguage,
                  responseVerbosity: globalSettings.responseVerbosity
                }).then((res) => {
                  if (!res.ok) onOverrideError?.(res.error)
                })
              } else {
                void onSetOverride(path, {
                  ...override,
                  useOverride: false
                }).then((res) => {
                  if (!res.ok) onOverrideError?.(res.error)
                })
              }
            }}
          />
          Override
        </label>
      </div>
      {useOverride ? (
        <div className="mt-2.5 flex flex-col gap-2 border-t border-border pt-2.5">
          <Menu
            aria-label={`Provider for ${workspaceShort(path)}`}
            value={provider}
            options={providerOptions}
            searchable={false}
            placement="down"
            disabled={disabled}
            onChange={(value) => {
              const nextProvider = value as ProviderId
              const nextModel = defaultModelFor(nextProvider)
              setProvider(nextProvider)
              setModel(nextModel)
              void persist({ provider: nextProvider, model: nextModel })
            }}
          />
          <Input
            className="w-full"
            aria-label={`Model for ${workspaceShort(path)}`}
            disabled={disabled}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => {
              const trimmed = model.trim()
              if (!trimmed) {
                setModel(override?.model ?? globalSettings.model)
                return
              }
              if (trimmed !== (override?.model ?? globalSettings.model)) {
                void persist({ model: trimmed })
              }
            }}
          />
          {provider === 'custom' ? (
            <Input
              className="w-full"
              aria-label={`Custom OpenAI base URL for ${workspaceShort(path)}`}
              disabled={disabled}
              value={customUrl}
              placeholder={CUSTOM_OPENAI_DEFAULT}
              onChange={(e) => setCustomUrl(e.target.value)}
              onBlur={() => {
                const current =
                  override?.customOpenAiBaseUrl ?? globalSettings.customOpenAiBaseUrl
                if (!customUrl.trim()) {
                  // Empty keeps the previous affordance: fall back to the
                  // local default rather than erroring.
                  setCustomUrl(CUSTOM_OPENAI_DEFAULT)
                  if (CUSTOM_OPENAI_DEFAULT !== current) {
                    void persist({ customOpenAiBaseUrl: CUSTOM_OPENAI_DEFAULT })
                  }
                  return
                }
                const parsed = validateCustomOpenAiBaseUrl(customUrl)
                if (!parsed.ok) {
                  onOverrideError?.(parsed.error)
                  return
                }
                setCustomUrl(parsed.url)
                if (parsed.url !== current) {
                  void persist({ customOpenAiBaseUrl: parsed.url })
                }
              }}
            />
          ) : null}
          <p className="m-0 text-2xs leading-snug text-muted">
            Reasoning and thinking effort are in the composer. Compaction is in Settings → Agent; approval is in Settings → Tools.
          </p>
        </div>
      ) : (
        <p className="m-0 mt-2 text-xs text-muted">
          Uses global defaults ({providerLabel(globalSettings.provider)} · {globalSettings.model})
        </p>
      )}
    </div>
  )
}
