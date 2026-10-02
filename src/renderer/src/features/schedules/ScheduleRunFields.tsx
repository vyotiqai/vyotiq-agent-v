import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, emptySecretStatus, type ModelRef, type SecretProvider, type Settings } from '@shared/ipc'
import { Checkbox } from '@renderer/lib/ui'
import { ModelRefPicker, type ModelRefPickerForm } from '@renderer/features/settings/components/ModelRefField'

type PickerSettings = { form: ModelRefPickerForm; secrets: Record<SecretProvider, boolean> }

/**
 * What the model picker needs from the saved settings — the providers with a
 * key, and where Ollama and the custom endpoint live — read once while a
 * schedule form is open. The picker is the one Settings → Agent uses.
 */
function usePickerSettings(): PickerSettings {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [secrets, setSecrets] = useState<Record<SecretProvider, boolean>>(emptySecretStatus)
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.vyotiq?.getSettings?.(), window.vyotiq?.secretStatus?.()])
      .then(([s, k]) => {
        if (cancelled) return
        if (s?.ok) setSettings(s.data)
        if (k?.ok) setSecrets(k.data.keys)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  return {
    form: {
      settings,
      customProviders: settings.customProviders,
      refreshingModels: false,
      formLocked: false
    },
    secrets
  }
}

/**
 * How each run starts, under when: the model it runs on (none = the default
 * at the time), and — for a git folder — whether it gets a new worktree.
 * Rows share ScheduleFields' label column, so the fields keep one left edge.
 */
export function ScheduleRunFields({
  model,
  onModelChange,
  worktree,
  onWorktreeChange,
  showWorktree
}: {
  model: ModelRef | null
  onModelChange: (next: ModelRef | null) => void
  worktree: boolean
  onWorktreeChange: (next: boolean) => void
  /** False for a folder that is not a git repository: there is no worktree to make. */
  showWorktree: boolean
}) {
  const picker = usePickerSettings()
  return (
    <div className="flex flex-col gap-3" data-schedule-run-fields>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-sm text-secondary">Model</span>
        <ModelRefPicker
          title="Model"
          value={model}
          form={picker.form}
          secrets={picker.secrets}
          emptyLabel="Default model"
          onChange={onModelChange}
        />
      </div>
      {showWorktree ? (
        <Checkbox checked={worktree} onCheckedChange={onWorktreeChange} label="Run each time in a new worktree" />
      ) : null}
    </div>
  )
}
