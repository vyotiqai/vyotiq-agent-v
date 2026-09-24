import { Menu, cn, selectTriggerClass } from '@renderer/lib/ui'
import type { IconName } from '@renderer/lib/icons'
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
  /** Model ids and commands read as code. */
  mono?: boolean
  icon?: IconName
  /** Smallest width of the menu, so a column of them shares one left edge. */
  width?: number
}) {
  const { mono = false, icon, width = 180, ...rest } = layout
  return (
    <SettingsField id={id} title={title} {...rest}>
      <div style={{ minWidth: width }}>
        <Menu
          aria-label={label ?? title}
          value={value}
          options={[...options]}
          searchable={false}
          placement="down"
          disabled={disabled}
          icon={icon}
          // At its default the value is readable but not asking to be read.
          triggerClassName={cn(selectTriggerClass({ quiet: !rest.changed, mono }), 'w-full')}
          onChange={(next) => {
            if (next !== value) onChange(next as T)
          }}
        />
      </div>
    </SettingsField>
  )
}
