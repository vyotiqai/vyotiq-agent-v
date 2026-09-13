import { useEffect, useRef, type ReactElement } from 'react'
import { VyotiqMark } from '@renderer/lib/brand'
import { useUpdater } from './useUpdater'
import type { UpdateProgress } from './types'

const BYTES_PER_MB = 1024 * 1024

/** Pure formatters — module-level so render derives nothing per-call. */
function formatMb(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1)
}

function clampPercent(progress: UpdateProgress | null | undefined): number {
  if (!progress) return 0
  return Math.max(0, Math.min(100, Math.round(progress.percent)))
}

/** e.g. "Sep 11, 2026". Empty string for missing/invalid dates. */
function formatReleaseDate(releaseDate: string | undefined): string {
  if (!releaseDate) return ''
  const date = new Date(releaseDate)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

function openReleaseNotes(url: string | undefined): void {
  if (!url) return
  void window.vyotiq?.shellOpenExternal(url).catch(() => {})
}

const dismissButtonClass =
  'shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-accent'

/**
 * Fixed bottom-right update card. Renders nothing unless a new version is
 * available/downloading/downloaded, so the main UI never shifts. The release
 * notes ("What's new") stay visible through every state — available,
 * downloading and downloaded — so the recent changes are always in view.
 */
export function UpdateCard(): ReactElement | null {
  const { info, status, progress, download, install, dismiss } = useUpdater()
  const cardRef = useRef<HTMLDivElement>(null)

  const visible = info != null

  // Focus management: the card takes focus when it appears. Non-modal, so the
  // rest of the UI stays interactive and layout never shifts.
  useEffect(() => {
    if (visible) cardRef.current?.focus()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, dismiss])

  if (info == null) return null

  const percent = clampPercent(progress)
  const dateLabel = formatReleaseDate(info.releaseDate)
  const hasSections = (info.notesSections?.length ?? 0) > 0
  const hasNotes = hasSections || info.notesText.trim().length > 0

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="update-card-title"
      tabIndex={-1}
      className="fixed bottom-4 right-4 z-dropdown w-96 animate-fade-in overflow-hidden rounded-xl border border-border bg-bg text-fg shadow-menu outline-none"
      data-update-card
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
              Update available
            </p>
            <h2 id="update-card-title" className="truncate text-sm font-semibold">
              {info.releaseName}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
              <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] text-fg">
                v{info.version}
              </span>
              {dateLabel ? <span>{dateLabel}</span> : null}
            </p>
          </div>
          <button
            type="button"
            aria-label="Dismiss update notification"
            title="Dismiss update notification"
            className={dismissButtonClass}
            onClick={dismiss}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {hasNotes ? (
          <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[var(--vy-tracking)] text-muted">
              What’s new
            </p>
            {hasSections
              ? info.notesSections.map((section, sectionIndex) => (
                  <div
                    key={section.heading || `notes-${sectionIndex}`}
                    className={sectionIndex === 0 ? 'mt-1.5' : 'mt-3'}
                  >
                    {section.heading ? (
                      <h4 className="inline-flex items-center rounded bg-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg">
                        {section.heading}
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
                ))
              : (
                  <p className="mt-1.5 whitespace-pre-line text-xs leading-relaxed text-muted">
                    {info.notesText}
                  </p>
                )}
          </div>
        ) : null}

        <div className="mt-3">
          {status === 'available' ? (
            <button
              type="button"
              className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline focus-visible:outline-accent"
              onClick={download}
            >
              Download update
            </button>
          ) : null}

          {status === 'downloading' ? (
            <div>
              <div
                role="progressbar"
                aria-label={`Downloading update, ${percent}% complete`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted" aria-live="polite">
                {percent}% · {formatMb(progress?.transferred ?? 0)} MB of{' '}
                {formatMb(progress?.total ?? 0)} MB
              </p>
            </div>
          ) : null}

          {status === 'downloaded' ? (
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline focus-visible:outline-accent"
                onClick={install}
              >
                Install &amp; restart
              </button>
              <button
                type="button"
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-accent"
                onClick={dismiss}
              >
                Later
              </button>
            </div>
          ) : null}
        </div>

        {info.releaseUrl ? (
          <div className="mt-2.5 border-t border-border pt-2.5">
            <button
              type="button"
              className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline focus-visible:outline-accent"
              onClick={() => openReleaseNotes(info.releaseUrl)}
            >
              Full release notes
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
