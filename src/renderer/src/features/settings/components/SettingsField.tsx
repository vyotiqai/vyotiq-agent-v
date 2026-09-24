import type { ReactNode } from 'react'
import { FormCard, FormGroup, FormRow, FormStack } from '@renderer/lib/ui'
import type { SettingReset } from '../hooks/useSettingsForm'

/**
 * Settings-named view of the shared form grammar in `lib/ui/FormRow`.
 *
 * The layout moved so other surfaces could use it without importing across
 * features. These wrappers keep the Settings names and, more importantly, the
 * `data-settings-field` / `data-settings-card` attributes: the settings search
 * index queries `[data-settings-field="<id>"]` to scroll and highlight a
 * result, so renaming it here would silently break search, not just markup.
 */

const FIELD_ATTRIBUTE = 'data-settings-field'
const CARD_ATTRIBUTE = 'data-settings-card'

export function SettingsStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return <FormStack className={className}>{children}</FormStack>
}

export function SettingsCard({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <FormCard className={className} dataAttribute={CARD_ATTRIBUTE}>
      {children}
    </FormCard>
  )
}

/** A caps label over ruled rows; `description` is the note beside the label. */
export function SettingsGroup({
  title,
  description,
  fieldId,
  plain,
  children
}: {
  title?: string
  /** One line beside the label, for what the rows share. */
  description?: string
  /**
   * Makes the group a search target, for groups whose rows are data rather
   * than settings of their own (one per workspace, one per provider).
   */
  fieldId?: string
  /** One block rather than rows — a picker, a meter — so nothing rules it. */
  plain?: boolean
  children: ReactNode
}) {
  return (
    <FormGroup
      title={title}
      description={description}
      cardDataAttribute={CARD_ATTRIBUTE}
      anchor={fieldId ? { attribute: FIELD_ATTRIBUTE, id: fieldId } : undefined}
      plain={plain}
    >
      {children}
    </FormGroup>
  )
}

export type SettingsFieldLayout = {
  /** Short one-liner shown under the title. */
  hint?: ReactNode
  /** Longer technical copy shown in a ? tooltip. */
  help?: string
  /** Marker after the title — see `workspaceBadge`. */
  badge?: ReactNode
  /** Indented under the row above it: a limit that belongs to that switch. */
  nested?: boolean
  /** Set away from its default — see `form.defaultMark`. */
  changed?: boolean
  /** Puts it back to its default. */
  onReset?: () => void
  /** What `onReset` writes, so Reset section can merge every row into one save. */
  resetTo?: SettingReset
  /** More under the row, full width: chips, a progress bar, a short list. */
  below?: ReactNode
}

export function SettingsField({
  id,
  title,
  hint,
  help,
  badge,
  nested = false,
  changed,
  onReset,
  resetTo,
  below,
  wide = false,
  children,
  className
}: SettingsFieldLayout & {
  /** Stable field id for search scroll/highlight (`data-settings-field`). */
  id: string
  title: string
  /**
   * Full-width control under the title (accordions, textareas, lists).
   * Default is copy left, control right.
   */
  wide?: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <FormRow
      id={id}
      title={title}
      hint={hint}
      help={help}
      badge={badge}
      indent={nested}
      wide={wide}
      changed={changed}
      onReset={onReset}
      resetToken={resetTo}
      below={below}
      className={className}
      dataAttribute={FIELD_ATTRIBUTE}
    >
      {children}
    </FormRow>
  )
}

/**
 * A row of data rather than a setting of its own — one per workspace, per
 * provider, per model. Same layout as `SettingsField`, but no search target:
 * the rows come and go with what is on disk, so search lands on their group
 * (`SettingsGroup fieldId`) instead.
 */
export function SettingsItem({
  id,
  title,
  hint,
  help,
  badge,
  nested = false,
  changed,
  onReset,
  resetTo,
  below,
  wide = false,
  children,
  className
}: SettingsFieldLayout & {
  id: string
  title: string
  wide?: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <FormRow
      id={id}
      title={title}
      hint={hint}
      help={help}
      badge={badge}
      indent={nested}
      wide={wide}
      changed={changed}
      onReset={onReset}
      resetToken={resetTo}
      below={below}
      className={className}
      dataAttribute="data-settings-item"
    >
      {children}
    </FormRow>
  )
}
