import { Switch } from '@renderer/lib/ui'
import { SettingsField, type SettingsFieldLayout } from './SettingsField'

/**
 * A setting that is on or off: the row copy on the left, the switch on the
 * right edge where every other row keeps its control. Thirty-odd rows spelled
 * this out by hand, each free to drift on size and label.
 *
 * The switch is named by the row title; pass `label` only when the title is
 * ambiguous out of context (a screen reader lists switches without their rows).
 */
export function SwitchField({
  id,
  title,
  label,
  checked,
  disabled,
  onChange,
  ...layout
}: SettingsFieldLayout & {
  id: string
  title: string
  label?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <SettingsField id={id} title={title} {...layout}>
      <Switch
        size="md"
        checked={checked}
        disabled={disabled}
        label={label ?? title}
        onCheckedChange={onChange}
      />
    </SettingsField>
  )
}
