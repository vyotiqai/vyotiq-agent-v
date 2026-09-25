import { useId, useRef, type ReactElement } from 'react'
import type { ReleaseNotesSection } from '@shared/ipc/schemas/updater'
import { releaseNoteHeadline } from '@shared/utils/releaseNotes'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { VyotiqMark } from '@renderer/lib/brand'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { useWhatsNew } from './useWhatsNew'

/** Repo hosting the per-version release pages linked from the modal. */
const RELEASES_URL = 'https://github.com/vyotiqai/vyotiq-agent-v-releases'

/**
 * How a release-notes heading reads here. The notes are written under Added,
 * Improved, Fixed, Security, Removed and Known issues; "Added" reads as New,
 * and a heading this does not know keeps its own words.
 */
const SECTION_LOOK: Record<string, { label: string; icon: IconName }> = {
  added: { label: 'New', icon: 'skill' },
  new: { label: 'New', icon: 'skill' },
  improved: { label: 'Improved', icon: 'effort' },
  fixed: { label: 'Fixed', icon: 'check' },
  security: { label: 'Security', icon: 'shield' },
  removed: { label: 'Removed', icon: 'minus' },
  'known issues': { label: 'Known issues', icon: 'warning' }
}

export function sectionLook(heading: string): { label: string; icon: IconName } | null {
  const trimmed = heading.trim()
  if (!trimmed) return null
  return SECTION_LOOK[trimmed.toLowerCase()] ?? { label: trimmed, icon: 'note' }
}

function Sections({ sections }: { sections: ReleaseNotesSection[] }): ReactElement {
  return (
    <>
      {sections.map((section, index) => {
        const look = sectionLook(section.heading)
        return (
          <section key={`${section.heading}-${index}`}>
            {look ? (
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Icon name={look.icon} size={13} className="text-muted" />
                {look.label}
              </h3>
            ) : null}
            <ul className={look ? 'mt-1.5 space-y-1 pl-5 text-sm text-secondary' : 'space-y-1 pl-5 text-sm text-secondary'}>
              {section.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`} className="list-disc marker:text-tertiary">
                  {releaseNoteHeadline(item)}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}

/**
 * What's new, after an update restarts the app: the version now running, the
 * one it replaced, and the release's items under their headings, each by its
 * lead sentence. Gated by useWhatsNew — nothing on a first install or an
 * unchanged version.
 */
export function WhatsNewModal(): ReactElement | null {
  const { open, currentVersion, lastRunVersion, pendingNotes, dismiss } = useWhatsNew()
  const titleId = useId()
  const gotItRef = useRef<HTMLButtonElement>(null)

  if (!open || currentVersion == null) return null

  const releaseUrl = `${RELEASES_URL}/releases/tag/v${currentVersion}`
  const sections = pendingNotes?.notesSections.filter((s) => s.items.length > 0) ?? []
  const prose = sections.length === 0 ? (pendingNotes?.notesText.trim() ?? '') : ''

  return (
    <Dialog
      open
      onClose={dismiss}
      labelledBy={titleId}
      useNativeDialog={false}
      padded={false}
      initialFocusRef={gotItRef}
      className="vy-menu flex w-[500px] flex-col overflow-hidden"
    >
      <div data-whats-new-modal className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface text-fg-strong">
            <VyotiqMark size={20} decorative />
          </span>
          <div className="min-w-0">
            <div className={SECTION_LABEL}>What’s new</div>
            <h2 id={titleId} className="text-heading font-semibold text-fg-strong">
              Agent V {currentVersion}
            </h2>
          </div>
          <span className="flex-1" />
          {lastRunVersion != null ? (
            <span className="shrink-0 font-mono text-caption text-tertiary">from {lastRunVersion}</span>
          ) : null}
        </div>
        <div className="max-h-[min(60vh,32rem)] min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {sections.length > 0 ? (
            <Sections sections={sections} />
          ) : prose ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-secondary">{prose}</p>
          ) : (
            <p className="text-sm text-secondary">
              Agent V was updated to {currentVersion}. The release notes list everything that changed.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center border-t border-border px-5 py-3">
          <button
            type="button"
            className="rounded-sm text-xs text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
            onClick={() => void window.vyotiq?.shellOpenExternal(releaseUrl).catch(() => {})}
          >
            Full release notes
          </button>
          <span className="flex-1" />
          <Button ref={gotItRef} size="sm" variant="primary" onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
