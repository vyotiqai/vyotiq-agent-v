import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ModelRef, ProviderIdAny, Settings } from '@shared/ipc'
import { providerOptionsForConfigured } from '@shared/providers'
import { Menu, cn, selectTriggerClass } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { useModelOptions } from '../hooks/useModelOptions'
import { SettingsField } from './SettingsField'

const SAME_AS_TASK = ''

/**
 * A provider and one of its models, or "Same as the task". The model is only
 * saved once one is picked: a provider alone is not a choice the schema can
 * hold, so picking one opens its model list and waits.
 */
export function ModelRefField({
  id,
  title,
  hint,
  help,
  value,
  form,
  secrets,
  onChange
}: {
  id: string
  title: string
  hint: string
  help?: string
  value: ModelRef | null
  form: SettingsFormState
  secrets: SettingsViewProps['secrets']
  onChange: (next: ModelRef | null) => void
}): JSX.Element {
  return (
    <SettingsField id={id} title={title} hint={hint} help={help}>
      <ModelRefPicker title={title} value={value} form={form} secrets={secrets} onChange={onChange} />
    </SettingsField>
  )
}

/**
 * What the picker reads from the settings form. A surface outside Settings (a
 * schedule's model) builds just this from the saved settings.
 */
export type ModelRefPickerForm = {
  settings: Pick<Settings, 'provider' | 'ollamaBaseUrl' | 'customOpenAiBaseUrl'>
  customProviders: Settings['customProviders']
  refreshingModels: boolean
  formLocked: boolean
}

/**
 * The provider and model menus on their own, for rows that are not a setting
 * of their own (Fallback models, a schedule's model). `emptyLabel` names the
 * no-model choice.
 */
export function ModelRefPicker({
  title,
  value,
  form,
  secrets,
  onChange,
  emptyLabel = 'Same as the task'
}: {
  title: string
  value: ModelRef | null
  form: ModelRefPickerForm
  secrets: SettingsViewProps['secrets']
  onChange: (next: ModelRef | null) => void
  emptyLabel?: string
}): JSX.Element {
  const settings = form.settings
  const [provider, setProvider] = useState<ProviderIdAny | typeof SAME_AS_TASK>(value?.provider ?? SAME_AS_TASK)
  useEffect(() => setProvider(value?.provider ?? SAME_AS_TASK), [value?.provider])

  const providerOptions = useMemo(
    () => [
      { value: SAME_AS_TASK, label: emptyLabel },
      ...providerOptionsForConfigured(secrets, {
        ollamaBaseUrl: settings.ollamaBaseUrl,
        customOpenAiBaseUrl: settings.customOpenAiBaseUrl,
        customProviders: form.customProviders,
        alwaysInclude: value ? [value.provider] : []
      })
    ],
    [emptyLabel, secrets, settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, form.customProviders, value]
  )
  const listFor: ProviderIdAny = provider || settings.provider
  const baseUrl =
    listFor === 'ollama' ? settings.ollamaBaseUrl : listFor === 'custom' ? settings.customOpenAiBaseUrl : undefined
  const currentModel = value && value.provider === provider ? value.model : ''
  const modelOptions = useModelOptions(listFor, baseUrl, currentModel, form.refreshingModels)
  const modelMenu = useMemo(
    () => (currentModel ? modelOptions : [{ value: '', label: 'Choose a model' }, ...modelOptions]),
    [currentModel, modelOptions]
  )

  return (
    <div className="flex items-center gap-1">
      <div style={{ minWidth: 150 }}>
        <Menu
          aria-label={`${title}: provider`}
          value={provider}
          options={providerOptions}
          placement="down"
          disabled={form.formLocked}
          quiet={provider === SAME_AS_TASK}
          icon="cpu"
          triggerClassName={cn(selectTriggerClass({ quiet: provider === SAME_AS_TASK }), 'w-full')}
          onChange={(next) => {
            if (next === SAME_AS_TASK) {
              setProvider(SAME_AS_TASK)
              if (value) onChange(null)
              return
            }
            setProvider(next as ProviderIdAny)
          }}
        />
      </div>
      {provider !== SAME_AS_TASK ? (
        <div style={{ minWidth: 190 }}>
          <Menu
            aria-label={`${title}: model`}
            value={currentModel}
            options={modelMenu}
            searchable={modelMenu.length > 8}
            searchPlaceholder="Find a model"
            title={currentModel || undefined}
            placement="down"
            disabled={form.formLocked}
            icon="model"
            triggerClassName={cn(selectTriggerClass({ quiet: !currentModel, mono: true }), 'w-full')}
            onChange={(model) => {
              if (!model) return
              onChange({ provider: provider as ProviderIdAny, model })
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
