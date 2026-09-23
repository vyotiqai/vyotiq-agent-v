import type { ReactNode } from 'react'
import { FormCard, FormGroup, FormRow, FormStack } from '@renderer/lib/ui'

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

/** Group label + card. Pass `title` for the muted heading above the card. */
export function SettingsGroup({
  title,
  description,
  children
}: {
  title?: string
  /** One sentence under the heading, for what the rows share. */
  description?: string
  children: ReactNode
}) {
  return (
    <FormGroup title={title} description={description} cardDataAttribute={CARD_ATTRIBUTE}>
      {children}
    </FormGroup>
  )
}

export type SettingsFieldLayout = {
  /** Short one-liner shown under the title. */
  hint?: string
  /** Longer technical copy shown in a ? tooltip. */
  help?: string
  /** Marker after the title — see `workspaceBadge`. */
  badge?: ReactNode
  /** Indented under the row above it: a limit that belongs to that switch. */
  nested?: boolean
}

export function SettingsField({
  id,
  title,
  hint,
  help,
  badge,
  nested = false,
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
  children: ReactNode
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
      className={className}
      dataAttribute={FIELD_ATTRIBUTE}
    >
      {children}
    </FormRow>
  )
}
