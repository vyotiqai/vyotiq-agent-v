import { DEFAULT_SETTINGS, type ModelInfo } from '@shared/ipc'
import { Segmented } from '@renderer/lib/ui'
import {
  buildModes,
  modeIndex,
  modelShowsThinkingControls,
  resolveThinkingUiMeta
} from '@renderer/features/chat/components/composer/ThinkingControls'
import { effortFootNote, effortNotes } from '@renderer/features/chat/components/composer/effortCost'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField } from './SettingsField'
import { workspaceBadge } from './WorkspaceBadge'

/**
 * The effort new tasks start at, beside the model it applies to — the same
 * value, and the same levels, as the effort under the instruction line's
 * model menu. It writes where that one does: the open workspace's override
 * while it has one, the app-wide setting otherwise, and the provider's own
 * remembered effort either way.
 */
export function EffortField({ form, models }: { form: SettingsFormState; models: readonly ModelInfo[] }) {
  const provider = form.displayProvider
  const model = form.displayModel
  // The list is the app-wide provider's; an override on another provider has no entry in it.
  const meta = provider === form.settings.provider ? models.find((m) => m.id === model) : undefined
  const thinks = modelShowsThinkingControls(provider, model, meta)
  const ui = resolveThinkingUiMeta(provider, model, meta)
  // A model that does not think still gets the whole ladder: the setting outlives the model.
  const modes = thinks
    ? buildModes(ui.supportedThinkingEfforts, ui.thinkingCanDisable, ui.thinkingMode, ui.thinkingDefaultEffort)
    : buildModes(undefined, true, undefined)
  const enabled = form.effectiveChatSettings?.thinkingEnabled ?? form.settings.thinkingEnabled
  const effort = form.effectiveChatSettings?.thinkingEffort ?? form.settings.thinkingEffort
  const at = modeIndex(modes, enabled, effort)
  const selected = modes[at]
  const said = thinks ? effortNotes(modes, { provider, model, meta, onOffOnly: ui.thinkingMode === 'boolean' })[at] : null
  const note = selected && said ? `${selected.label}: ${said}` : undefined
  const changed =
    enabled !== DEFAULT_SETTINGS.thinkingEnabled || (enabled && effort !== DEFAULT_SETTINGS.thinkingEffort)

  return (
    <SettingsField
      id="thinking-effort"
      title="Effort"
      hint={thinks ? note : `${model} does not think; this applies to a model that does.`}
      help={`How long the model thinks before each step. ${effortFootNote(provider, model)} The model menu under a task sets the same value.`}
      badge={workspaceBadge(form.workspaceOverrideActive)}
      changed={changed}
      onReset={() => {
        void form.runAgentUpdate({
          thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
          thinkingEffort: DEFAULT_SETTINGS.thinkingEffort
        })
      }}
    >
      <Segmented
        label="Effort"
        value={String(at)}
        disabled={form.formLocked}
        items={modes.map((m, i) => ({ id: String(i), label: m.short, title: m.label }))}
        onChange={(id) => {
          const next = modes[Number(id)]
          if (!next || Number(id) === at) return
          void form.runAgentUpdate(
            next.enabled ? { thinkingEnabled: true, thinkingEffort: next.effort } : { thinkingEnabled: false }
          )
        }}
      />
    </SettingsField>
  )
}
