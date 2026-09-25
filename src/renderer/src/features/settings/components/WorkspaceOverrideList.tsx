import { useEffect, useId, useMemo, useState } from 'react'
import type { ProviderId, SecretProvider, Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import {
  CUSTOM_OPENAI_DEFAULT,
  defaultModelFor,
  validateCustomOpenAiBaseUrl,
  providerOptionsForConfigured
} from '@shared/providers'
import { findByWorkspacePath, workspacePathsEqual } from '@shared/workspacePathMatch'
import { Button, Input, Menu, Switch } from '@renderer/lib/ui'
import { workspaceShort } from '../utils/settingsHelpers'
import { SettingsItem } from './SettingsField'

type SetOverride = (
  path: string,
  override: WorkspaceSettingsOverride | null
) => Promise<{ ok: true } | { ok: false; error: string }>

/**
 * Open workspaces, one row each: its name, its path, and the switch that gives
 * it its own model and agent settings. An override starts from the app-wide
 * values; the rows marked "this workspace" elsewhere in Settings edit it while
 * that workspace is open. Its model can be changed here too, for a workspace
 * that is not.
 */
export function WorkspaceOverrideList({
  paths,
  activePath,
  globalSettings,
  secrets,
  overridesByPath,
  disabled,
  onSetOverride,
  onError
}: {
  paths: string[]
  activePath: string | null
  globalSettings: Settings
  secrets: Record<SecretProvider, boolean>
  overridesByPath: Record<string, WorkspaceSettingsOverride>
  disabled?: boolean
  onSetOverride: SetOverride
  onError: (message: string) => void
}) {
  if (paths.length === 0) {
    return <p className="m-0 py-3 text-xs text-muted">No workspaces open.</p>
  }
  return (
    <>
      {paths.map((path) => (
        <WorkspaceOverrideRow
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
    </>
  )
}

function WorkspaceOverrideRow({
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
  const [editing, setEditing] = useState(false)
  const editorId = useId()
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
    if (!on) setEditing(false)
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

  const editors = (
    <div id={editorId} className="flex flex-wrap items-center gap-2">
      <div className="w-44 shrink-0">
        <Menu
          aria-label={`Provider for ${name}`}
          value={provider}
          options={providerOptions}
          searchable={false}
          placement="down"
          disabled={disabled}
          icon="cpu"
          triggerClassName="w-full"
          onChange={(value) => {
            if (value === provider) return
            const nextProvider = value as ProviderId
            const nextModel = defaultModelFor(nextProvider)
            setProvider(nextProvider)
            setModel(nextModel)
            void persist({ provider: nextProvider, model: nextModel })
          }}
        />
      </div>
      <div className="min-w-48 flex-1">
        <Input
          size="sm"
          mono
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
      </div>
      {provider === 'custom' ? (
        <div className="w-full">
          <Input
            size="sm"
            mono
            aria-label={`Custom OpenAI base URL for ${name}`}
            disabled={disabled}
            value={customUrl}
            placeholder={CUSTOM_OPENAI_DEFAULT}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            onBlur={() => {
              const current = override?.customOpenAiBaseUrl ?? globalSettings.customOpenAiBaseUrl
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
        </div>
      ) : null}
    </div>
  )

  return (
    <SettingsItem
      id={`workspace:${path}`}
      title={name}
      hint={path}
      badge={isActive ? <span className="text-caption text-tertiary">active</span> : null}
      changed={useOverride}
      onReset={() => setUseOverride(false)}
      below={useOverride && editing ? editors : null}
    >
      <div className="flex items-center gap-2">
        {/* The model the override runs, and the way to change it without
            opening the workspace. */}
        {useOverride ? (
          <Button
            size="xs"
            variant="ghost"
            trailingIcon={editing ? 'chevronUp' : 'chevron'}
            aria-expanded={editing}
            aria-controls={editing ? editorId : undefined}
            aria-label={`Model for ${name}: ${override?.model ?? model}`}
            onClick={() => setEditing((open) => !open)}
          >
            <span className="max-w-56 truncate font-mono font-normal">{override?.model ?? model}</span>
          </Button>
        ) : null}
        <Switch
          size="md"
          checked={useOverride}
          disabled={disabled}
          label={`Override settings for ${name}`}
          onCheckedChange={setUseOverride}
        />
      </div>
    </SettingsItem>
  )
}
