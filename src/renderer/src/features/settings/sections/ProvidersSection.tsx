import { useMemo } from 'react'
import { SECRET_PROVIDERS, type ProviderId } from '@shared/ipc'
import { providerLabel, providerOptionsForConfigured } from '@shared/providers'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SettingsNotice } from '../components/SettingsNotice'
import { ProviderKeyAccordion } from '../components/ProviderKeyAccordion'
import { workspaceBadge } from '../components/WorkspaceBadge'

export function ProvidersSection({
  secrets,
  secretsLoadError = false,
  form,
  onClearSecret,
  onOpenComposerModel
}: {
  secrets: SettingsViewProps['secrets']
  secretsLoadError?: boolean
  form: SettingsFormState
  onClearSecret: SettingsViewProps['onClearSecret']
  onOpenComposerModel?: () => void
}) {
  const settings = form.settings
  const activeProviderOptions = useMemo(
    () =>
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: settings.ollamaBaseUrl,
        customOpenAiBaseUrl: settings.customOpenAiBaseUrl,
        alwaysInclude: [settings.provider]
      }),
    [secrets, settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, settings.provider]
  )
  // A workspace override can pin a different provider; name it only then, so
  // the common case reads as just the model under the provider row above.
  const modelLabel =
    form.workspaceOverrideActive && form.displayProvider !== settings.provider
      ? `${form.displayProviderMeta?.label ?? form.displayProvider} · ${form.displayModel}`
      : form.displayModel

  return (
    <SettingsStack>
      {secretsLoadError ? (
        <SettingsNotice tone="warning">
          Saved API keys could not be read. They may still be on disk — re-enter a key, or
          check secrets.json.
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
          title="Active provider"
          hint="Used for chat and the model list."
          help="Opening a key below only edits that key; it never switches the active provider."
          value={settings.provider}
          options={activeProviderOptions}
          disabled={form.formLocked}
          onChange={(provider) => {
            void form.setActiveProvider(provider as ProviderId)
          }}
        />
        {/* The menu always holds the active provider (and local Ollama needs
            no key), so it is never empty; the gap worth naming is an active
            provider that cannot run. With no other key saved, the way out is
            adding one. */}
        {form.activeNeedsKey ? (
          <div
            className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs leading-snug text-secondary"
            role="status"
          >
            <span className="min-w-0">
              {providerLabel(settings.provider)} has no API key.{' '}
              {form.savedKeyProviders.length > 0
                ? 'Switch to one that does:'
                : 'Add one under API keys below.'}
            </span>
            {form.savedKeyProviders.map((id) => (
              <Button
                key={id}
                variant="subtle"
                disabled={form.formLocked}
                onClick={() => {
                  void form.setActiveProvider(id as ProviderId)
                }}
              >
                Use {providerLabel(id)}
              </Button>
            ))}
          </div>
        ) : null}
        <SettingsField
          id="active-model"
          title="Active model"
          hint="Pick a different model in the composer."
          badge={workspaceBadge(form.workspaceOverrideActive)}
        >
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <span className="min-w-0 truncate text-sm text-fg" title={modelLabel}>
              {modelLabel}
            </span>
            {onOpenComposerModel ? (
              <Button
                variant="subtle"
                className="shrink-0"
                disabled={form.formLocked}
                onClick={onOpenComposerModel}
              >
                Change
              </Button>
            ) : null}
          </div>
        </SettingsField>
        <SettingsField
          id="refresh-models"
          title="Refresh models"
          hint={`Reload the model list for ${form.providerMeta?.label ?? settings.provider}. Saving a key does this too.`}
          help="Fetches the list the composer's model picker shows. It never changes the active model."
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
            className="m-0 px-4 py-3 text-xs leading-snug text-secondary [overflow-wrap:anywhere]"
            role="status"
          >
            {form.modelsInfo}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="API keys">
        <SettingsField
          id="api-keys"
          title="API keys"
          hint={
            form.encryptionAvailable
              ? `OS secure storage · ${form.savedKeyCount}/${SECRET_PROVIDERS.length} saved`
              : 'Unavailable without OS secure storage.'
          }
          help="Open a provider to edit its key and, for Ollama and custom endpoints, its base URL. Saving a key does not change the active provider. Keys never leave encrypted local storage."
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
            onSelectProvider={form.selectKeyProvider}
            onSetActive={(id) => {
              void form.setActiveProvider(id as ProviderId)
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
    </SettingsStack>
  )
}
