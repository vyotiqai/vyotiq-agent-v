import { useEffect, useRef, type ReactElement } from 'react'
import { VyotiqMark } from '@renderer/lib/brand'
import type { ReleaseNotesSection } from '@shared/ipc/schemas/updater'
import { useWhatsNew } from './useWhatsNew'

/** Repo hosting the per-version release pages linked from the modal. */
const RELEASES_URL = 'https://github.com/vyotiqai/vyotiq-agent-v-releases'

/**
 * Categorize a parsed `## Heading` onto the canonical display heading when it
 * matches a known category; unknown headings pass through unchanged.
 */
function displayHeading(heading: string): string {
  const normalized = heading.toLowerCase()
  if (normalized.includes('feature')) return '🚀 Features'
  if (/fix|stability|bug/.test(normalized)) return '🛠️ Fixes & Stability'
  if (normalized.includes('performance')) return '⚡ Performance Improvements'
  return heading
}

function SectionList({ sections }: { sections: ReleaseNotesSection[] }): ReactElement {
  return (
    <>
      {sections.map((section, index) => (
        <div key={section.heading || `section-${index}`} className={index === 0 ? '' : 'mt-3'}>
          {section.heading ? (
            <h4 className="inline-flex items-center rounded bg-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg">
              {displayHeading(section.heading)}
            </h4>
          ) : null}
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted">
            {section.items.map((item) => (
              <li key={item} className="flex gap-1.5">
                <span
                  aria-hidden="true"
                  className="mt-[7px] size-1 shrink-0 rounded-full bg-accent"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

/**
 * Centered post-restart "What's New" modal (Stage B of the dual-stage update
 * flow). Gated by useWhatsNew: shows only when the running version is newer
 * than the version recorded at the end of the previous run. Renders nothing
 * on first install and on an unchanged version.
 */
export function WhatsNewModal(): ReactElement | null {
  const { open, currentVersion, lastRunVersion, pendingNotes, dismiss } = useWhatsNew()
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus management: focus moves into the modal while it is open (mirrors
  // UpdateCard's focus behavior).
  useEffect(() => {
    if (open) dialogRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismiss])

  if (!open || currentVersion == null) return null

  const githubUrl = `${RELEASES_URL}/releases/tag/v${currentVersion}`
  const hasNotes =
    pendingNotes != null &&
    (pendingNotes.notesSections.length > 0 || pendingNotes.notesText.trim().length > 0)

  return (
    <div className="fixed inset-0 z-dropdown flex animate-fade-in items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        tabIndex={-1}
        data-whats-new-modal
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-bg text-fg shadow-menu outline-none"
      >
        <div aria-hidden="true" className="h-0.5 bg-accent opacity-80" />

        <div className="p-4">
          <div className="flex items-start gap-3">
            <div
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-accent"
            >
              <VyotiqMark size={18} decorative />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--vy-tracking)] text-muted">
                What’s new
              </p>
              <h2 id="whats-new-title" className="text-sm font-semibold">
                Welcome to Vyotiq v{currentVersion}
              </h2>
              {lastRunVersion != null ? (
                <p className="mt-1 text-xs text-muted">
                  Here is what changed since your last version (v{lastRunVersion}):
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-3">
            {hasNotes && pendingNotes != null ? (
              pendingNotes.notesSections.length > 0 ? (
                <SectionList sections={pendingNotes.notesSections} />
              ) : (
                <p className="whitespace-pre-line text-xs leading-relaxed text-muted">
                  {pendingNotes.notesText}
                </p>
              )
            ) : (
              <p className="text-xs leading-relaxed text-muted">
                Vyotiq was updated to v{currentVersion}. See the full release notes on GitHub for
                everything that changed.
              </p>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline focus-visible:outline-accent"
              onClick={() => void window.vyotiq?.shellOpenExternal(githubUrl).catch(() => {})}
            >
              Full Release Notes on GitHub
            </button>
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline focus-visible:outline-accent"
              onClick={dismiss}
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
