import { useEffect, useState, type ReactElement } from 'react'
import type { UpdateInfo, UpdateProgress, UpdaterStatePayload } from '@shared/ipc'
import { releaseNoteHeadline } from '@shared/utils/releaseNotes'
import { Button, ProgressBar } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { downloadUpdate, installUpdate } from './updaterStore'

const BYTES_PER_MB = 1024 * 1024

/** How many of the release's items the panel names; the rest are a click away. */
const HEADLINES = 3

function formatMb(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1)
}

function clampPercent(progress: UpdateProgress | null | undefined): number {
  if (!progress) return 0
  return Math.max(0, Math.min(100, progress.percent))
}

/** "22 Sep" in the reader's locale, with the year only when it is not this one. '' when unknown. */
export function formatReleaseDay(releaseDate: string | undefined, now: Date = new Date()): string {
  if (!releaseDate) return ''
  const date = new Date(releaseDate)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
}

/** The first items of the release, each by its lead sentence, in the order the notes give them. */
export function updateHeadlines(info: Pick<UpdateInfo, 'notesSections'>, count = HEADLINES): string[] {
  return (info.notesSections ?? [])
    .flatMap((section) => section.items)
    .map(releaseNoteHeadline)
    .filter(Boolean)
    .slice(0, count)
}

/**
 * What a restart does to work in flight. Only the task you open picks its run
 * back up (Settings → Agent → Resume interrupted runs); with that off, a task
 * offers Continue. A goal relaunches on its own either way — both lines stay
 * true for it.
 */
export function restartLine(runningCount: number, resumeOnOpen: boolean | null): string | null {
  if (runningCount <= 0 || resumeOnOpen == null) return null
  return resumeOnOpen ? 'Running tasks resume when you open them' : 'Running tasks can be continued after restart'
}

function openReleaseNotes(url: string | undefined): void {
  if (!url) return
  void window.vyotiq?.shellOpenExternal(url).catch(() => {})
}

/** The Resume interrupted runs setting, read when a restart is on offer. Null until known. */
function useResumeOnOpen(active: boolean): boolean | null {
  const [value, setValue] = useState<boolean | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void window.vyotiq
      ?.getSettings?.()
      .then((res) => {
        if (!cancelled && res.ok) setValue(res.data.autoResumeInterruptedRuns)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [active])
  return value
}

const STATUS_LABEL: Partial<Record<UpdaterStatePayload['status'], string>> = {
  available: 'Update available',
  downloading: 'Downloading',
  downloaded: 'Update ready'
}

/**
 * The navigator chip's popover: which version, when it shipped, the first of
 * what changed, and the one action the update is waiting on — download it, or
 * restart to install it.
 *
 * Nothing here runs on its own: the download starts when the user presses
 * Download, and the install when they press Restart and install.
 */
export function UpdatePanel({
  info,
  status,
  progress,
  runningCount = 0
}: {
  info: UpdateInfo
  status: UpdaterStatePayload['status']
  progress: UpdateProgress | null
  /** Tasks running now — a restart interrupts them. */
  runningCount?: number
}): ReactElement {
  const percent = clampPercent(progress)
  const day = formatReleaseDay(info.releaseDate)
  const headlines = updateHeadlines(info)
  const prose = headlines.length === 0 ? info.notesText.trim() : ''
  const restarting = status === 'downloaded'
  const resumeOnOpen = useResumeOnOpen(restarting && runningCount > 0)
  const restart = restarting ? restartLine(runningCount, resumeOnOpen) : null

  return (
    <div data-update-panel>
      <div className="px-4 pb-3 pt-4">
        <div className={SECTION_LABEL}>{STATUS_LABEL[status] ?? 'Update'}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <h2 className="text-heading font-semibold text-fg-strong">Agent V {info.version}</h2>
          {day ? <span className="font-mono text-caption text-tertiary">{day}</span> : null}
        </div>
        {headlines.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs leading-[18px] text-secondary">
            {headlines.map((line) => (
              <li key={line} className="flex gap-1.5">
                <span aria-hidden="true">•</span>
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        ) : prose ? (
          <p className="mt-2 line-clamp-3 text-xs leading-[18px] text-secondary">{prose}</p>
        ) : null}
      </div>
      <div className="border-t border-border px-4 py-3">
        {status === 'available' ? (
          <Button variant="primary" size="sm" icon="download" className="w-full" onClick={downloadUpdate}>
            Download update
          </Button>
        ) : null}
        {status === 'downloading' ? (
          <div>
            <ProgressBar value={percent} max={100} tone="accent" label={`Downloading update, ${Math.round(percent)}% complete`} />
            <p className="mt-1.5 text-caption text-tertiary tnum" aria-live="polite">
              {Math.round(percent)}% · {formatMb(progress?.transferred ?? 0)} MB of {formatMb(progress?.total ?? 0)} MB
            </p>
          </div>
        ) : null}
        {restarting ? (
          <Button variant="primary" size="sm" icon="retry" className="w-full" onClick={installUpdate}>
            Restart and install
          </Button>
        ) : null}
        {restart || info.releaseUrl ? (
          <div className="mt-2 flex items-center gap-2 text-caption text-tertiary">
            {restart ? <span className="min-w-0 flex-1">{restart}</span> : <span className="flex-1" />}
            {info.releaseUrl ? (
              <button
                type="button"
                className="shrink-0 rounded-sm text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
                onClick={() => openReleaseNotes(info.releaseUrl)}
              >
                Release notes
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
