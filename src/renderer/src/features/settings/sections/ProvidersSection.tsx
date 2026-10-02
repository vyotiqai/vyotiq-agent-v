import { useMemo } from 'react'
import { MAX_CUSTOM_PROVIDERS, type ProviderIdAny, type SecretProvider } from '@shared/ipc'
import { providerLabel, providerOptionsForConfigured } from '@shared/providers'
import { findByWorkspacePath } from '@shared/workspacePathMatch'
import { Button, IconButton, Menu, selectTriggerClass, cn } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SettingsNotice } from '../components/SettingsNotice'
import { AddEndpointRow, ProviderKeys } from '../components/ProviderKeys'
import { PROVIDER_KEY_ORDER } from '../constants'
import { modelMenuOptions, useModelList } from '../hooks/useModelOptions'
import { EffortField } from '../components/EffortField'
import { FallbackModelsField } from '../components/FallbackModelsField'
import { workspaceShort } from '../utils/settingsHelpers'

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
  const customProviders = form.customProviders
  const providerOptions = useMemo(
    () =>
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: settings.ollamaBaseUrl,
        customOpenAiBaseUrl: settings.customOpenAiBaseUrl,
        customProviders,
        alwaysInclude: [settings.provider]
      }),
    [secrets, settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, customProviders, settings.provider]
  )
  // The builtin Custom row sits with the endpoints the user added, so each
  // group answers one question: which keys are saved, which hosts are set up.
  const keyIds = useMemo(() => PROVIDER_KEY_ORDER.filter((id) => id !== 'custom'), [])
  const endpointIds = useMemo<SecretProvider[]>(
    () => ['custom', ...customProviders.map((entry) => entry.id)],
    [customProviders]
  )
  const savedKeyCount = keyIds.filter((id) => secrets[id]).length
  // An added endpoint's catalog comes from its own saved base URL (main
  // resolves it from the list), so only the builtin hosts pass one here.
  const baseUrl =
    settings.provider === 'ollama'
      ? settings.ollamaBaseUrl
      : settings.provider === 'custom'
        ? settings.customOpenAiBaseUrl
        : undefined
  const models = useModelList(settings.provider, baseUrl, form.refreshingModels)
  const modelOptions = useMemo(() => modelMenuOptions(models, settings.model), [models, settings.model])

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
        overrideModel.provider !== settings.provider
          ? ` on ${providerLabel(overrideModel.provider, customProviders)}`
          : ''
      }.`
    : undefined

  const clearKey = (): void => {
    void form.clearKey(onClearSecret)
  }

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
              ? `${form.providerDisplayLabel} has no API key.${
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
                      void form.setActiveProvider(id as ProviderIdAny)
                    }}
                  >
                    Use {providerLabel(id, customProviders)}
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
            void form.setActiveProvider(provider as ProviderIdAny)
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
              label={`Refresh the ${form.providerDisplayLabel} model list`}
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
        <EffortField form={form} models={models} />
        <FallbackModelsField form={form} secrets={secrets} />
      </SettingsGroup>

      <SettingsGroup
        title="API keys"
        fieldId="api-keys"
        description={
          form.encryptionAvailable
            ? `${savedKeyCount} of ${keyIds.length} saved`
            : 'Unavailable without OS secure storage'
        }
      >
        <ProviderKeys ids={keyIds} form={form} secrets={secrets} onClearKey={clearKey} />
      </SettingsGroup>

      <SettingsGroup
        title="Custom endpoints"
        fieldId="custom-endpoints"
        description={
          customProviders.length > 0
            ? `${customProviders.length} added`
            : 'Any OpenAI-compatible server: vLLM, llama.cpp, LM Studio, a hosted gateway'
        }
      >
        <ProviderKeys ids={endpointIds} form={form} secrets={secrets} onClearKey={clearKey} />
        <AddEndpointRow form={form} max={MAX_CUSTOM_PROVIDERS} />
      </SettingsGroup>
    </SettingsStack>
  )
}
