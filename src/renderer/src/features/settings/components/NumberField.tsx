import { Input } from '@renderer/lib/ui'
import { SETTINGS_ERROR_IDS } from '../constants'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsErrorField } from '../types'
import { SettingsField, type SettingsFieldLayout } from './SettingsField'

type BoundedField = Exclude<SettingsErrorField, null>

/**
 * A bounded integer setting: label, unit, and an inline error under the input.
 *
 * Every numeric row in Settings is the same shape — parse, revert-or-commit,
 * explain — and it used to exist two ways: Agent got an inline message under
 * the field; Storage hand-rolled a raw `<input type="number">` (no focus ring,
 * no disabled state) and pushed its error to the page-level alert, so the
 * explanation landed a screen away from the field it was about. This is the
 * one way.
 *
 * `key` carries the persisted value: a rejected edit must snap back to what is
 * stored, and remounting is how an uncontrolled input does that.
 */
export function NumberField({
  id,
  field,
  form,
  title,
  label,
  unit,
  min,
  max,
  value,
  disabled,
  onCommit,
  ...layout
}: SettingsFieldLayout & {
  /** Search id (`data-settings-field`). */
  id: string
  /** Which error slot this row owns, so its message renders here. */
  field: BoundedField
  form: SettingsFormState
  title: string
  /** Accessible name of the input when the title alone is ambiguous. */
  label?: string
  /** Suffix after the input — `turns`, `%`, `days`, `GB`. */
  unit?: string
  min: number
  max: number
  /** The persisted value; also the revert target for a rejected edit. */
  value: number
  disabled?: boolean
  onCommit: (value: number) => void
}) {
  const owned = form.errorField === field
  const name = label ?? title
  // "from 7 to 365 days", "from 50 to 95%": the unit belongs in the error too.
  const unitSuffix = unit ? (unit === '%' ? unit : ` ${unit}`) : ''

  return (
    <SettingsField id={id} title={title} {...layout}>
      <div className="flex items-center gap-1.5">
        {/* Width comes from this wrapper: Input is `w-full`, and cn() has no
            tailwind-merge, so a `w-24` passed to it lost to that `w-full` and
            every number box shrank to whatever its row's hint left over. */}
        <div className="w-24 shrink-0">
          <Input
            type="number"
            className="tabular-nums"
            aria-label={name}
            min={min}
            max={max}
            disabled={disabled}
            defaultValue={value}
            key={`${id}-${value}`}
            aria-invalid={owned ? true : undefined}
            aria-describedby={owned ? SETTINGS_ERROR_IDS[field] : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            onBlur={(e) => {
              const raw = e.target.value.trim()
              const parsed = Number(raw)
              if (!raw || !Number.isFinite(parsed) || parsed < min || parsed > max) {
                e.target.value = String(value)
                form.setFieldError(field, `${name} must be from ${min} to ${max}${unitSuffix}.`)
                return
              }
              // Only this row's own message: a blur must not dismiss an error
              // some other control is still showing.
              if (owned) form.clearErrors()
              const next = Math.round(parsed)
              if (next !== value) onCommit(next)
            }}
          />
        </div>
        {/* Fixed width so the inputs share one right edge whatever the unit —
            "sessions" and "%" otherwise pushed them to different columns. */}
        {unit ? <span className="w-14 shrink-0 text-xs text-muted">{unit}</span> : null}
      </div>
      {form.fieldError[field]}
    </SettingsField>
  )
}
