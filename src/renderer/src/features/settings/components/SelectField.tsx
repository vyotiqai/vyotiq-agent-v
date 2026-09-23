import { Menu } from '@renderer/lib/ui'
import type { SettingsOption } from '../types'
import { SettingsField, type SettingsFieldLayout } from './SettingsField'

/**
 * A setting with a few named values, as a dropdown on the row's right edge.
 *
 * Picking the value that is already selected is not a change, so it never
 * reaches `onChange` — the menus used to write settings.json on every re-pick.
 * `T` carries the setting's own union through, so call sites need no casts.
 */
export function SelectField<T extends string>({
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
  /** Accessible name of the menu when the title alone is ambiguous. */
  label?: string
  value: T
  options: readonly SettingsOption<T>[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <SettingsField id={id} title={title} {...layout}>
      <Menu
        aria-label={label ?? title}
        value={value}
        options={[...options]}
        searchable={false}
        placement="down"
        disabled={disabled}
        onChange={(next) => {
          if (next !== value) onChange(next as T)
        }}
      />
    </SettingsField>
  )
}
