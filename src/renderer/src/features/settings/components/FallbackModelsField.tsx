import type { JSX } from 'react'
import {
  DEFAULT_MODEL_FALLBACK,
  MAX_FALLBACK_MODELS,
  type ModelFallbackSettings,
  type ModelRef
} from '@shared/ipc'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { ModelRefPicker } from './ModelRefField'
import { SettingsItem } from './SettingsField'
import { SwitchField } from './SwitchField'

/**
 * Fallback models: a switch, then up to three models in the order a step
 * tries them when the task's provider is down. One empty slot follows the
 * last one set, so the list grows as it is filled; clearing a slot closes the
 * gap. What counts as down lives in main/agent/modelFallback.ts.
 */
export function FallbackModelsField({
  form,
  secrets
}: {
  form: SettingsFormState
  secrets: SettingsViewProps['secrets']
}): JSX.Element {
  const fallback: ModelFallbackSettings = form.settings.modelFallback ?? DEFAULT_MODEL_FALLBACK
  const models = fallback.models
  const save = (next: ModelFallbackSettings): void => {
    void form.runUpdate({ modelFallback: next })
  }
  const slots = Math.min(MAX_FALLBACK_MODELS, models.length + 1)

  return (
    <>
      <SwitchField
        id="model-fallback"
        title="Fall back when the provider is down"
        hint="A step moves to the next model below on an outage, then the next turn starts on this model again."
        help="Outages are 5xx and overloaded errors, refused or reset connections, DNS failures and timeouts. Usage and rate limits (429) keep waiting on the task's model, and a bad key is still reported. Within a long turn the task's model is tried again after 10 minutes."
        checked={fallback.enabled}
        disabled={form.formLocked}
        onChange={(enabled) => save({ ...fallback, enabled })}
        {...form.defaultMark('modelFallback')}
      />
      {fallback.enabled
        ? Array.from({ length: slots }, (_, i) => {
            const title = `Fallback ${i + 1}`
            return (
              <SettingsItem key={i} id={`model-fallback-${i + 1}`} title={title} nested>
                <ModelRefPicker
                  title={title}
                  value={models[i] ?? null}
                  form={form}
                  secrets={secrets}
                  emptyLabel="None"
                  onChange={(ref) => save({ ...fallback, models: withSlot(models, i, ref) })}
                />
              </SettingsItem>
            )
          })
        : null}
    </>
  )
}

/** The list with slot `i` set, or removed when `ref` is null; a repeat of another slot is dropped. */
export function withSlot(models: readonly ModelRef[], i: number, ref: ModelRef | null): ModelRef[] {
  const next = [...models]
  if (ref) next[i] = ref
  else next.splice(i, 1)
  return next.filter(
    (m, at) => next.findIndex((o) => o.provider === m.provider && o.model === m.model) === at
  ).slice(0, MAX_FALLBACK_MODELS)
}
