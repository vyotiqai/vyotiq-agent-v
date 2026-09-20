import type { ReactElement } from 'react'
import type { UpdateInfo, UpdateProgress, UpdaterStatePayload } from '@shared/ipc'
import { downloadUpdate, installUpdate } from './updaterStore'

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

/**
 * Body of the sidebar update popover. The release notes stay visible through
 * every state — available, downloading and downloaded — so what is changing is
 * always in view while deciding.
 *
 * Nothing here runs on its own: the download starts when the user presses
 * Download, and the install when they press Install & restart.
 */
export function UpdatePanel({
  info,
  status,
  progress
}: {
  info: UpdateInfo
  status: UpdaterStatePayload['status']
  progress: UpdateProgress | null
}): ReactElement {
  const percent = clampPercent(progress)
  const dateLabel = formatReleaseDate(info.releaseDate)
  const hasSections = (info.notesSections?.length ?? 0) > 0
  const hasNotes = hasSections || info.notesText.trim().length > 0

  return (
    <div className="p-3" data-update-panel>
      <div className="min-w-0">
        <p className="text-2xs font-semibold uppercase tracking-[var(--vy-tracking)] text-muted">
          Update available
        </p>
        <h2 className="truncate text-sm font-semibold text-fg">{info.releaseName}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg">
            v{info.version}
          </span>
          {dateLabel ? <span>{dateLabel}</span> : null}
        </p>
      </div>

      {hasNotes ? (
        <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-3">
          <p className="text-2xs font-semibold uppercase tracking-[var(--vy-tracking)] text-muted">
            What&rsquo;s new
          </p>
          {hasSections ? (
            info.notesSections.map((section, sectionIndex) => (
              <div
                key={section.heading || `notes-${sectionIndex}`}
                className={sectionIndex === 0 ? 'mt-1.5' : 'mt-3'}
              >
                {section.heading ? (
                  <h4 className="inline-flex items-center rounded bg-bg px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-fg">
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
          ) : (
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
            onClick={downloadUpdate}
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
          <button
            type="button"
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline focus-visible:outline-accent"
            onClick={installUpdate}
          >
            Install &amp; restart
          </button>
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
  )
}
