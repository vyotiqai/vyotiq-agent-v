import type { Ref } from 'react'
import { Icon } from '@renderer/lib/icons'
import { NavItem, cn } from '@renderer/lib/ui'
import { SETTINGS_NAV_WIDTH } from '@renderer/lib/utils/layout'
import { SECTION_GROUPS, SECTION_ICONS, SECTION_LABELS } from '../constants'
import type { SettingsSection } from '../types'

export function SettingsBackButton({
  backRef,
  onClose
}: {
  backRef?: Ref<HTMLButtonElement>
  onClose: () => void
}) {
  return (
    <button
      ref={backRef}
      type="button"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
      onClick={onClose}
    >
      <Icon name="chevron" size={14} className="rotate-90" />
      Back
    </button>
  )
}

/**
 * Sections in three labelled groups. Below `sm` the nav collapses to the
 * horizontal scroll strip it has always been — the headings would cost more
 * width than they buy there — so they are the one thing that appears only on
 * the wide layout.
 */
export function SettingsNav({
  section,
  onSectionChange
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
}) {
  return (
    <nav
      data-settings-nav
      className={cn(
        'flex shrink-0 flex-row items-center gap-0.5 overflow-x-auto px-2 pb-2',
        'sm:flex-col sm:items-stretch sm:gap-0 sm:overflow-visible sm:px-3 sm:pb-3 sm:pt-0',
        SETTINGS_NAV_WIDTH
      )}
      aria-label="Settings sections"
    >
      {SECTION_GROUPS.map((group) => (
        <div
          key={group.label}
          className="contents sm:mt-4 sm:flex sm:flex-col sm:gap-0.5 sm:first:mt-0"
        >
          <h2 className="m-0 hidden px-2.5 pb-1 text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-tertiary sm:block">
            {group.label}
          </h2>
          {group.sections.map((id) => (
            <NavItem
              key={id}
              variant="settings"
              label={SECTION_LABELS[id]}
              icon={SECTION_ICONS[id]}
              active={section === id}
              onClick={() => onSectionChange(id)}
            />
          ))}
        </div>
      ))}
    </nav>
  )
}
