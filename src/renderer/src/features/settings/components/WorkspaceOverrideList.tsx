import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ProviderId, SecretProvider, Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  defaultModelFor,
  validateCustomOpenAiBaseUrl,
  providerOptionsForConfigured
} from '@shared/providers'
import { findByWorkspacePath, workspacePathsEqual } from '@shared/workspacePathMatch'
import { Badge, Input, Menu, Switch } from '@renderer/lib/ui'
import { workspaceShort } from '../utils/settingsHelpers'

type SetOverride = (
  path: string,
  override: WorkspaceSettingsOverride | null
) => Promise<{ ok: true } | { ok: false; error: string }>

/**
 * Open workspaces as one divided list, each with its override switch on the
 * right edge. This replaced a bordered card per workspace inside the settings
 * card — borders on borders — plus a footnote under every card pointing at
 * three other sections.
 */
export function WorkspaceOverrideList({
  paths,
  activePath,
  globalSettings,
  secrets,
  overridesByPath,
  disabled,
  onSetOverride,
  onError,
  action
}: {
  paths: string[]
  activePath: string | null
  globalSettings: Settings
  secrets: Record<SecretProvider, boolean>
  overridesByPath: Record<string, WorkspaceSettingsOverride>
  disabled?: boolean
  onSetOverride: SetOverride
  onError: (message: string) => void
  /**
   * Closes the list as one more divided item (Add workspace), so it reads as
   * belonging to the list rather than to the last workspace's fields.
   */
  action?: ReactNode
}) {
  if (paths.length === 0) {
    return (
      <>
        <p className="m-0 text-xs text-muted">No workspaces open.</p>
        {action ? <div>{action}</div> : null}
      </>
    )
  }
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border/60 p-0" aria-label="Open workspaces">
      {paths.map((path) => (
        <WorkspaceOverrideItem
          key={path}
          path={path}
          isActive={activePath !== null && workspacePathsEqual(path, activePath)}
          globalSettings={globalSettings}
          secrets={secrets}
          override={findByWorkspacePath(overridesByPath, path) ?? undefined}
          disabled={disabled}
          onSetOverride={onSetOverride}
          onError={onError}
        />
      ))}
      {action ? <li className="pt-2.5">{action}</li> : null}
    </ul>
  )
}

function WorkspaceOverrideItem({
  path,
  isActive,
  globalSettings,
  secrets,
  override,
  disabled,
  onSetOverride,
  onError
}: {
  path: string
  isActive: boolean
  globalSettings: Settings
  secrets: Record<SecretProvider, boolean>
  override: WorkspaceSettingsOverride | undefined
  disabled?: boolean
  onSetOverride: SetOverride
  onError: (message: string) => void
}) {
  const name = workspaceShort(path)
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
    [secrets, globalSettings.ollamaBaseUrl, globalSettings.customOpenAiBaseUrl, provider]
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

  const report = (res: { ok: true } | { ok: false; error: string }): void => {
    if (!res.ok) onError(res.error)
  }

  const persist = async (patch: Partial<WorkspaceSettingsOverride>): Promise<void> => {
    report(
      await onSetOverride(path, {
        ...override,
        useOverride: true,
        provider: patch.provider ?? provider,
        model: patch.model ?? model,
        ...patch
      })
    )
  }

  const setUseOverride = (on: boolean): void => {
    // Turning an override on seeds it from the app-wide values, so the
    // workspace starts where it already was instead of on schema defaults.
    const next: WorkspaceSettingsOverride = on
      ? {
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
        }
      : { ...override, useOverride: false }
    void onSetOverride(path, next).then(report)
  }

  return (
    <li className="flex flex-col gap-2 py-2.5 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 flex min-w-0 items-center gap-1.5 text-sm tracking-[var(--vy-tracking)] text-fg">
            <span className="truncate">{name}</span>
            {isActive ? <Badge>Active</Badge> : null}
          </p>
          <p className="m-0 mt-0.5 truncate text-xs text-muted" title={path}>
            {path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted" aria-hidden>
            Override
          </span>
          <Switch
            size="md"
            checked={useOverride}
            disabled={disabled}
            label={`Override settings for ${name}`}
            onCheckedChange={setUseOverride}
          />
        </div>
      </div>
      {useOverride ? (
        <div className="flex flex-col gap-2">
          <Menu
            aria-label={`Provider for ${name}`}
            value={provider}
            options={providerOptions}
            searchable={false}
            placement="down"
            disabled={disabled}
            onChange={(value) => {
              if (value === provider) return
              const nextProvider = value as ProviderId
              const nextModel = defaultModelFor(nextProvider)
              setProvider(nextProvider)
              setModel(nextModel)
              void persist({ provider: nextProvider, model: nextModel })
            }}
          />
          <Input
            className="w-full"
            aria-label={`Model for ${name}`}
            disabled={disabled}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            onBlur={() => {
              const trimmed = model.trim()
              const current = override?.model ?? globalSettings.model
              if (!trimmed) {
                setModel(current)
                return
              }
              if (trimmed !== current) void persist({ model: trimmed })
            }}
          />
          {provider === 'custom' ? (
            <Input
              className="w-full"
              aria-label={`Custom OpenAI base URL for ${name}`}
              disabled={disabled}
              value={customUrl}
              placeholder={CUSTOM_OPENAI_DEFAULT}
              onChange={(e) => setCustomUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={() => {
                const current =
                  override?.customOpenAiBaseUrl ?? globalSettings.customOpenAiBaseUrl
                if (!customUrl.trim()) {
                  // Empty falls back to the local default rather than erroring.
                  setCustomUrl(CUSTOM_OPENAI_DEFAULT)
                  if (CUSTOM_OPENAI_DEFAULT !== current) {
                    void persist({ customOpenAiBaseUrl: CUSTOM_OPENAI_DEFAULT })
                  }
                  return
                }
                const parsed = validateCustomOpenAiBaseUrl(customUrl)
                if (!parsed.ok) {
                  onError(parsed.error)
                  return
                }
                setCustomUrl(parsed.url)
                if (parsed.url !== current) void persist({ customOpenAiBaseUrl: parsed.url })
              }}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
