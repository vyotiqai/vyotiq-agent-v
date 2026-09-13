import { useMemo } from 'react'
import { SECRET_PROVIDERS, type ProviderId, type Settings } from '@shared/ipc'
import { providerLabel, providerOptionsForConfigured } from '@shared/providers'
import { Menu, Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { ProviderKeyAccordion } from '../components/ProviderKeyAccordion'

export function ProvidersSection({
  settings,
  secrets,
  secretsLoadError = false,
  form,
  onClearSecret
}: {
  settings: Settings
  secrets: SettingsViewProps['secrets']
  secretsLoadError?: boolean
  form: SettingsFormState
  onClearSecret: SettingsViewProps['onClearSecret']
}) {
  const activeProviderOptions = useMemo(
    () =>
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: settings.ollamaBaseUrl,
        customOpenAiBaseUrl: settings.customOpenAiBaseUrl,
        alwaysInclude: [settings.provider]
      }),
    [secrets, settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, settings.provider]
  )

  return (
    <SettingsStack>
      {secretsLoadError ? (
        <p
          className="m-0 rounded-xl bg-surface px-4 py-3 text-xs leading-snug text-warning [overflow-wrap:anywhere]"
          role="status"
        >
          Could not read saved API keys. They may still be on disk. Re-enter keys or check
          secrets.json.
        </p>
      ) : null}
      <SettingsGroup title="Provider">
        <SettingsField
          id="active-provider"
          title="Active provider"
          hint="Used for chat and Refresh models."
          help="Selecting a provider here makes it active. Expanding an API key row only edits that key. Model is chosen in the composer."
        >
          <Menu
            aria-label="Active provider"
            value={settings.provider}
            options={activeProviderOptions}
            searchable={false}
            placement="down"
            disabled={form.formLocked || activeProviderOptions.length === 0}
            onChange={(v) => {
              void form.setActiveProvider(v as ProviderId)
            }}
          />
          {activeProviderOptions.length === 0 ? (
            <p className="m-0 mt-2 text-xs leading-snug text-secondary" role="status">
              No providers configured yet. Add an API key below or use local Ollama.
            </p>
          ) : null}
        </SettingsField>

        {form.activeNeedsKey && form.savedKeyProviders.length > 0 ? (
          <p
            className="m-0 px-4 py-3 text-xs leading-snug text-secondary [overflow-wrap:anywhere]"
            role="status"
          >
            Active provider is {providerLabel(settings.provider)} but its API key is
            missing. Switch to a provider with a saved key:{' '}
            {form.savedKeyProviders.map((id) => (
              <button
                key={id}
                type="button"
                className="mr-1.5 inline-flex rounded-sm border border-border bg-bg px-1.5 py-0.5 text-xs text-fg-strong vy-transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
                disabled={form.formLocked}
                onClick={() => {
                  void form.setActiveProvider(id)
                }}
              >
                Use {providerLabel(id)}
              </button>
            ))}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="API keys">
        <SettingsField
          id="api-keys"
          title="API keys"
          hint={
            form.encryptionAvailable
              ? `OS secure storage · ${form.savedKeyCount}/${SECRET_PROVIDERS.length} saved.`
              : 'OS secure storage is unavailable on this system.'
          }
          help="Expand a provider to edit its key. Saving a key does not change the active provider. Keys never leave encrypted local storage."
          wide
        >
          <ProviderKeyAccordion
            secrets={secrets}
            settingsProvider={settings.provider}
            encryptionAvailable={form.encryptionAvailable}
            keyProvider={form.keyProvider}
            keyDraft={form.keyDraft}
            keyHasSaved={form.keyHasSaved}
            keyProviderLabel={form.keyProviderLabel}
            formLocked={form.formLocked}
            savingKey={form.savingKey}
            clearingKey={form.clearingKey}
            errorField={form.errorField}
            displayError={form.displayError}
            ollamaUrl={{
              value: form.ollamaUrl,
              onChange: form.setOllamaUrl,
              onCommit: () => {
                void form.commitOllamaUrl()
              },
              error: form.fieldError.ollama
            }}
            customUrl={{
              value: form.customUrl,
              onChange: form.setCustomUrl,
              onCommit: () => {
                void form.commitCustomUrl()
              },
              error: form.fieldError.customUrl
            }}
            onKeyDraftChange={form.setKeyDraft}
            onSelectProvider={(id) => {
              form.selectKeyProvider(id)
            }}
            onSetActive={(id) => {
              void form.setActiveProvider(id)
            }}
            onSaveKey={() => {
              void form.saveKey()
            }}
            onClearKey={() => {
              void form.clearKey(onClearSecret)
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Catalog">
        <SettingsField
          id="refresh-models"
          title="Refresh models"
          hint={`Reload the live catalog for the active provider (${form.providerMeta?.label ?? settings.provider}). Saving a key refreshes that provider's catalog automatically.`}
          help="Fetches the provider model list used by the composer picker. Does not change the active model."
        >
          <Button
            variant="subtle"
            pending={form.refreshingModels}
            disabled={form.busy && !form.refreshingModels}
            onClick={() => {
              void form.refreshModels()
            }}
          >
            {form.refreshingModels ? 'Refreshing…' : 'Refresh models'}
          </Button>
        </SettingsField>
        {form.modelsInfo ? (
          <p
            className="m-0 px-4 py-3 text-xs text-secondary [overflow-wrap:anywhere]"
            role="status"
          >
            {form.modelsInfo}
          </p>
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  )
}
