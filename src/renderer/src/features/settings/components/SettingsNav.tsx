import type { Ref } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { NavItem, cn } from '@renderer/lib/ui'
import { SETTINGS_NAV_WIDTH } from '@renderer/lib/utils/layout'
import { SECTION_LABELS } from '../constants'
import type { SettingsSection } from '../types'

const SECTION_ICONS = {
  general: 'gear',
  appearance: 'sliders',
  providers: 'cpu',
  agent: 'bot',
  indexing: 'fileSearch',
  voice: 'mic',
  storage: 'stack',
  tools: 'plug',
  shortcuts: 'keyboard',
  about: 'info'
} as const satisfies Record<SettingsSection, IconName>

const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = (
  Object.keys(SECTION_LABELS) as SettingsSection[]
).map((id) => ({
  id,
  label: SECTION_LABELS[id].title,
  icon: SECTION_ICONS[id]
}))

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
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted vy-transition hover:bg-surface/50 hover:text-fg"
      onClick={onClose}
    >
      <Icon name="chevron" size={14} className="rotate-90" />
      Back
    </button>
  )
}

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
        'sm:flex-col sm:items-stretch sm:overflow-visible sm:px-3 sm:pb-3 sm:pt-0',
        SETTINGS_NAV_WIDTH
      )}
      aria-label="Settings sections"
    >
      {SECTIONS.map(({ id, label, icon }) => (
        <NavItem
          key={id}
          variant="settings"
          label={label}
          icon={icon}
          active={section === id}
          onClick={() => onSectionChange(id)}
        />
      ))}
    </nav>
  )
}
