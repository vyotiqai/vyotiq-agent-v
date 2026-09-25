import { useEffect, useMemo, useState } from 'react'
import { SECRET_PROVIDERS, type ProviderId } from '@shared/ipc'
import { providerLabel, providerOptionsForConfigured } from '@shared/providers'
import { findByWorkspacePath } from '@shared/workspacePathMatch'
import { Button, IconButton, Menu, selectTriggerClass, cn, type MenuOption } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SettingsNotice } from '../components/SettingsNotice'
import { ProviderKeys } from '../components/ProviderKeys'
import { workspaceShort } from '../utils/settingsHelpers'

/**
 * The provider's model list as the composer's picker has it, with the model
 * in use kept in it even when the list does not (yet) name it.
 */
function useModelOptions(
  provider: ProviderId,
  baseUrl: string | undefined,
  current: string,
  reloadKey: unknown
): MenuOption[] {
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    const list = window.vyotiq?.listModels
    if (!list) return undefined
    void list({ provider, baseUrl, forceRefresh: false })
      .then((res) => {
        if (!cancelled) setIds(res.ok ? res.data.models.map((m) => m.id) : [])
      })
      .catch(() => {
        if (!cancelled) setIds([])
      })
    return () => {
      cancelled = true
    }
  }, [provider, baseUrl, reloadKey])
  return useMemo(() => {
    const all = ids.includes(current) || !current ? ids : [current, ...ids]
    return all.map((id) => ({ value: id, label: id }))
  }, [ids, current])
}

export function ProvidersSection({
  secrets,
  secretsLoadError = false,
  form,
  onClearSecret,
  settingsOverridesByPath = {}
}: {
  secrets: SettingsViewProps['secrets']
  secretsLoadError?: boolean
  form: SettingsFormState
  onClearSecret: SettingsViewProps['onClearSecret']
  settingsOverridesByPath?: SettingsViewProps['settingsOverridesByPath']
}) {
  const settings = form.settings
  const providerOptions = useMemo(
    () =>
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: settings.ollamaBaseUrl,
        customOpenAiBaseUrl: settings.customOpenAiBaseUrl,
        alwaysInclude: [settings.provider]
      }),
    [secrets, settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, settings.provider]
  )
  const baseUrl =
    settings.provider === 'ollama'
      ? settings.ollamaBaseUrl
      : settings.provider === 'custom'
        ? settings.customOpenAiBaseUrl
        : undefined
  const modelOptions = useModelOptions(settings.provider, baseUrl, settings.model, form.refreshingModels)

  // The open workspace can run its own model; say which, since this row
  // does not change it.
  const override = form.activeWorkspacePath
    ? findByWorkspacePath(settingsOverridesByPath, form.activeWorkspacePath)
    : null
  const overrideModel =
    override?.useOverride && form.activeWorkspacePath
      ? {
          workspace: workspaceShort(form.activeWorkspacePath),
          model: override.model ?? settings.model,
          provider: override.provider ?? settings.provider
        }
      : null
  const overrideHint = overrideModel
    ? `${overrideModel.workspace} overrides this with ${overrideModel.model}${
        overrideModel.provider !== settings.provider ? ` on ${providerLabel(overrideModel.provider)}` : ''
      }.`
    : undefined

  return (
    <SettingsStack>
      {secretsLoadError ? (
        <SettingsNotice tone="warning">
          Saved API keys could not be read. They may still be on disk — re-enter a key, or check
          secrets.json.
        </SettingsNotice>
      ) : null}
      {!form.encryptionAvailable ? (
        <SettingsNotice tone="warning">
          OS secure storage is unavailable on this system, so API keys cannot be saved.
        </SettingsNotice>
      ) : null}

      <SettingsGroup title="Model">
        <SelectField
          id="active-provider"
          title="Provider for new tasks"
          // The menu always holds the provider in use (local Ollama needs no
          // key), so the gap worth naming is one that cannot run.
          hint={
            form.activeNeedsKey
              ? `${providerLabel(settings.provider)} has no API key.${
                  form.savedKeyProviders.length > 0 ? '' : ' Add one under API keys below.'
                }`
              : undefined
          }
          below={
            form.activeNeedsKey && form.savedKeyProviders.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Providers with a key">
                {form.savedKeyProviders.map((id) => (
                  <Button
                    key={id}
                    size="xs"
                    variant="secondary"
                    disabled={form.formLocked}
                    onClick={() => {
                      void form.setActiveProvider(id as ProviderId)
                    }}
                  >
                    Use {providerLabel(id)}
                  </Button>
                ))}
              </div>
            ) : null
          }
          icon="cpu"
          value={settings.provider}
          options={providerOptions}
          disabled={form.formLocked}
          onChange={(provider) => {
            void form.setActiveProvider(provider as ProviderId)
          }}
        />
        <SettingsField
          id="active-model"
          title="Model"
          hint={overrideHint}
          below={
            form.modelsInfo ? (
              <p className="m-0 text-xs text-muted [overflow-wrap:anywhere]" role="status">
                {form.modelsInfo}
              </p>
            ) : null
          }
        >
          <div className="flex items-center gap-1">
            <IconButton
              icon="refresh"
              label={`Refresh the ${providerLabel(settings.provider)} model list`}
              size="md"
              tone="muted"
              disabled={form.busy && !form.refreshingModels}
              aria-busy={form.refreshingModels || undefined}
              onClick={() => {
                void form.refreshModels()
              }}
            />
            <div style={{ minWidth: 190 }}>
              <Menu
                aria-label="Model"
                value={settings.model}
                options={modelOptions}
                searchable={modelOptions.length > 8}
                searchPlaceholder="Find a model"
                title={settings.model}
                placement="down"
                disabled={form.formLocked}
                icon="model"
                triggerClassName={cn(selectTriggerClass({ quiet: true, mono: true }), 'w-full')}
                onChange={(model) => {
                  void form.setGlobalModel(model)
                }}
              />
            </div>
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup
        title="API keys"
        fieldId="api-keys"
        description={
          form.encryptionAvailable
            ? `${form.savedKeyCount} of ${SECRET_PROVIDERS.length} saved`
            : 'Unavailable without OS secure storage'
        }
      >
        <ProviderKeys
          form={form}
          secrets={secrets}
          onClearKey={() => {
            void form.clearKey(onClearSecret)
          }}
        />
      </SettingsGroup>
    </SettingsStack>
  )
}
