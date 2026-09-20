import type { ReactNode } from 'react'
import { FormCard, FormGroup, FormGroupLabel, FormRow, FormStack } from '@renderer/lib/ui'

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

export function SettingsGroupLabel({ children }: { children: ReactNode }) {
  return <FormGroupLabel>{children}</FormGroupLabel>
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
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <FormGroup title={title} cardDataAttribute={CARD_ATTRIBUTE}>
      {children}
    </FormGroup>
  )
}

export function SettingsField({
  id,
  title,
  hint,
  help,
  wide = false,
  children,
  className
}: {
  /** Stable field id for search scroll/highlight (`data-settings-field`). */
  id: string
  title: string
  /** Short one-liner shown under the title. */
  hint?: string
  /** Longer technical copy shown in a ? tooltip. */
  help?: string
  /**
   * Full-width control under the title (accordions, textareas, lists).
   * Default is Cursor-style: copy left, control right.
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
      wide={wide}
      className={className}
      dataAttribute={FIELD_ATTRIBUTE}
    >
      {children}
    </FormRow>
  )
}
