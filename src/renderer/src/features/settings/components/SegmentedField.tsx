import { Segmented } from '@renderer/lib/ui'
import type { SettingsOption } from '../types'
import { SettingsField, type SettingsFieldLayout } from './SettingsField'

/**
 * A setting with two or three short values, all in view on the row's right
 * edge — where a dropdown would hide the choice behind a click.
 *
 * Picking the value already selected is not a change and never reaches
 * `onChange`, the same as `SelectField`.
 */
export function SegmentedField<T extends string>({
  id,
  title,
  label,
  value,
  options,
  disabled,
  onChange,
  ...layout
}: SettingsFieldLayout & {
  id: string
  title: string
  /** Accessible name of the group when the title alone is ambiguous. */
  label?: string
  value: T
  options: readonly SettingsOption<T>[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <SettingsField id={id} title={title} {...layout}>
      <Segmented
        label={label ?? title}
        value={value}
        disabled={disabled}
        items={options.map((option) => ({ id: option.value, label: option.label, disabled: option.disabled }))}
        onChange={(next) => {
          if (next !== value) onChange(next)
        }}
      />
    </SettingsField>
  )
}
