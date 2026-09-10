import { useEffect, useRef, type ReactElement } from 'react'
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

/**
 * Fixed bottom-right update card. Renders nothing unless a new version is
 * available/downloading/downloaded, so the main UI never shifts.
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

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="update-card-title"
      tabIndex={-1}
      className="fixed bottom-4 right-4 z-dropdown w-80 animate-fade-in rounded-lg border border-border bg-bg p-4 text-fg shadow-menu outline-none"
      data-update-card
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="update-card-title" className="truncate text-sm font-semibold">
            {info.releaseName}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            New version <span className="font-mono">v{info.version}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss update notification"
          title="Dismiss update notification"
          className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-fg focus-visible:outline focus-visible:outline-accent"
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

      {(info.notesSections?.length ?? 0) > 0 ? (
        <div className="mt-3 max-h-40 overflow-y-auto">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            What’s new
          </h3>
          {info.notesSections.map((section) => (
            <div key={section.heading} className="mt-2">
              <h4 className="text-xs font-semibold text-fg">{section.heading}</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        {status === 'available' ? (
          <button
            type="button"
            className="w-full rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 focus-visible:outline focus-visible:outline-accent"
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
          <button
            type="button"
            className="w-full rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 focus-visible:outline focus-visible:outline-accent"
            onClick={install}
          >
            Install &amp; restart
          </button>
        ) : null}
      </div>
    </div>
  )
}
