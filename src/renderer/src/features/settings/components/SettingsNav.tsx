import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { SECTION_GROUPS, SECTION_ICONS, SECTION_LABELS } from '../constants'
import type { SettingsSection } from '../types'

/** A section that needs attention, with the reason read out for it. */
export type SettingsIssues = Partial<Record<SettingsSection, string>>

/** Arrow keys, Home and End move between the index's section rows. */
function moveBetweenSections(e: KeyboardEvent<HTMLButtonElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const rows = [
    ...(e.currentTarget.closest('nav')?.querySelectorAll<HTMLButtonElement>('[data-settings-section]') ?? [])
  ]
  if (rows.length === 0) return
  const i = rows.indexOf(e.currentTarget)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? rows.length - 1
        : e.key === 'ArrowDown'
          ? Math.min(i + 1, rows.length - 1)
          : Math.max(i - 1, 0)
  e.preventDefault()
  rows[next]?.focus()
}

function BackButton({
  label,
  backRef,
  onBack,
  className
}: {
  label: string
  backRef?: Ref<HTMLButtonElement>
  onBack: () => void
  className?: string
}) {
  return (
    <button
      ref={backRef}
      type="button"
      data-settings-back
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-sm text-secondary vy-transition hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring',
        className
      )}
      onClick={onBack}
    >
      <Icon name="arrowLeft" size={15} />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function IssueMark({ reason }: { reason: string }) {
  return (
    <span role="img" aria-label={reason} title={reason} className="inline-flex shrink-0 text-warning">
      <Icon name="warningCircle" size={13} />
    </span>
  )
}

/**
 * Settings' own index, in the navigator's column while Settings is open:
 * Back to wherever you came from, search, the sections in three groups, and
 * the one fact the whole page shares — nothing here waits for a Save.
 */
export function SettingsIndex({
  section,
  onSectionChange,
  backLabel,
  backRef,
  onBack,
  issues = {},
  search
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  backLabel: string
  backRef?: Ref<HTMLButtonElement>
  onBack: () => void
  issues?: SettingsIssues
  search: ReactNode
}) {
  return (
    <nav aria-label="Settings" data-settings-nav className="flex h-full min-h-0 w-full flex-col">
      <div className="px-2 pb-2 pt-1">
        <BackButton label={backLabel} backRef={backRef} onBack={onBack} className="w-full" />
        <div className="mt-1.5">{search}</div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2">
        {SECTION_GROUPS.map((group) => (
          <div key={group.label} className="mt-3 first:mt-1">
            <h3 className={cn('flex h-6 items-center px-2', SECTION_LABEL)}>{group.label}</h3>
            {group.sections.map((id) => {
              const on = id === section
              const issue = issues[id]
              return (
                <button
                  key={id}
                  type="button"
                  data-settings-section={id}
                  aria-current={on ? 'page' : undefined}
                  className={cn(
                    'flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm vy-transition focus-visible:vy-focus-ring',
                    on ? 'bg-surface-2 font-medium text-fg-strong' : 'text-secondary hover:bg-surface hover:text-fg-strong'
                  )}
                  onClick={() => onSectionChange(id)}
                  onKeyDown={moveBetweenSections}
                >
                  <Icon name={SECTION_ICONS[id]} size={15} className={on ? 'text-fg-strong' : 'text-muted'} />
                  <span className="min-w-0 flex-1 truncate text-left">{SECTION_LABELS[id]}</span>
                  {issue ? <IssueMark reason={issue} /> : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex h-10 shrink-0 items-center px-4 text-caption text-tertiary">Changes save as you make them</div>
    </nav>
  )
}

/**
 * The same index as one row over the page, for when the navigator's column is
 * not there to hold it — hidden, or a drawer below the desktop breakpoint.
 */
export function SettingsIndexStrip({
  section,
  onSectionChange,
  backLabel,
  backRef,
  onBack,
  issues = {},
  search
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  backLabel: string
  backRef?: Ref<HTMLButtonElement>
  onBack: () => void
  issues?: SettingsIssues
  search: ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2 py-1.5" data-settings-nav-strip>
      <div className="flex items-center gap-2">
        <BackButton label={backLabel} backRef={backRef} onBack={onBack} className="shrink-0" />
        <div className="min-w-0 flex-1">{search}</div>
      </div>
      <nav aria-label="Settings" data-settings-nav className="scroll-thin flex items-center gap-0.5 overflow-x-auto">
        {SECTION_GROUPS.flatMap((group) => group.sections).map((id) => {
          const on = id === section
          const issue = issues[id]
          return (
            <button
              key={id}
              type="button"
              data-settings-section={id}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm vy-transition focus-visible:vy-focus-ring',
                on ? 'bg-surface-2 font-medium text-fg-strong' : 'text-secondary hover:bg-surface hover:text-fg-strong'
              )}
              onClick={() => onSectionChange(id)}
            >
              <Icon name={SECTION_ICONS[id]} size={15} className={on ? 'text-fg-strong' : 'text-muted'} />
              {SECTION_LABELS[id]}
              {issue ? <IssueMark reason={issue} /> : null}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
