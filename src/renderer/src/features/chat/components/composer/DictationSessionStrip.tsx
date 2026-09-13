import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { DictationWaveformStyle } from '@shared/ipc'
import { chromeIconButton, chromeLabelText, chromePillButton, chromeRow } from './composerChrome'

export type DictationSettingsSection = 'voice' | 'providers'

export type DictationStripState =
  | { kind: 'checking'; elapsedMs: number; waveform: readonly number[] }
  | { kind: 'listening'; elapsedMs: number; waveform: readonly number[] }
  | { kind: 'transcribing'; elapsedMs: number; waveform: readonly number[] }
  | { kind: 'error'; message: string; settingsSection: DictationSettingsSection | null }

export const DICTATION_WAVEFORM_BARS = 96

function settingsActionLabel(section: DictationSettingsSection): string {
  switch (section) {
    case 'voice':
      return 'Open Voice settings'
    case 'providers':
      return 'Open Providers'
    default: {
      const _exhaustive: never = section
      return _exhaustive
    }
  }
}

const iconBtn = chromeIconButton

const waveTrack = 'h-8 min-w-0 flex-1 overflow-hidden'

function amp(raw: number): number {
  return Math.max(0.06, Math.min(1, raw))
}

function pickSamples(samples: readonly number[], count: number): number[] {
  if (count <= 0) return []
  if (samples.length === 0) return Array.from({ length: count }, () => 0.08)
  if (samples.length <= count) return [...samples]
  const out = new Array<number>(count)
  const step = samples.length / count
  for (let i = 0; i < count; i++) {
    out[i] = samples[Math.min(samples.length - 1, Math.floor(i * step))] ?? 0.08
  }
  return out
}

/** Live waveform visualizer — shared by the inline dictation session and the error state. */
export function Waveform({
  samples,
  style
}: {
  samples: readonly number[]
  style: DictationWaveformStyle
}) {
  switch (style) {
    case 'bars': {
      const bars = pickSamples(samples, 40)
      return (
        <div className={cn(waveTrack, 'flex items-center gap-0.5')} aria-hidden>
          {bars.map((raw, i) => (
            <span
              key={i}
              className="min-w-px flex-1 basis-0 self-center rounded-sm bg-muted"
              style={{ height: `${Math.round(3 + amp(raw) * 25)}px` }}
            />
          ))}
        </div>
      )
    }
    case 'dots': {
      const dots = pickSamples(samples, 36)
      return (
        <div className={cn(waveTrack, 'flex items-center justify-between gap-px')} aria-hidden>
          {dots.map((raw, i) => {
            const px = Math.round(3 + amp(raw) * 13)
            return (
              <span
                key={i}
                className="shrink-0 rounded-full bg-muted"
                style={{ width: `${px}px`, height: `${px}px` }}
              />
            )
          })}
        </div>
      )
    }
    case 'line': {
      const pts = pickSamples(samples, 48)
      const w = 100
      const h = 28
      const last = Math.max(1, pts.length - 1)
      const d = pts
        .map((raw, i) => {
          const x = (i / last) * w
          const y = h / 2 - amp(raw) * (h / 2 - 2)
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
        })
        .join(' ')
      return (
        <svg
          className={cn(waveTrack, 'text-muted')}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d={d || `M0 ${h / 2} L${w} ${h / 2}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )
    }
    case 'mirror': {
      const bars = pickSamples(samples, 40)
      return (
        <div className={cn(waveTrack, 'flex flex-col')} aria-hidden>
          <div className="flex h-1/2 items-end gap-0.5">
            {bars.map((raw, i) => (
              <span
                key={`t-${i}`}
                className="min-w-px flex-1 basis-0 rounded-t-sm bg-muted"
                style={{ height: `${Math.round(2 + amp(raw) * 12)}px` }}
              />
            ))}
          </div>
          <div className="flex h-1/2 items-start gap-0.5 opacity-50">
            {bars.map((raw, i) => (
              <span
                key={`b-${i}`}
                className="min-w-px flex-1 basis-0 rounded-b-sm bg-muted"
                style={{ height: `${Math.round(2 + amp(raw) * 12)}px` }}
              />
            ))}
          </div>
        </div>
      )
    }
    default: {
      const _exhaustive: never = style
      return _exhaustive
    }
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function DictationErrorBanner({
  message,
  settingsSection,
  onDismiss,
  onOpenSettings
}: {
  message: string
  settingsSection: DictationSettingsSection | null
  onDismiss: () => void
  onOpenSettings?: (section: DictationSettingsSection) => void
}) {
  return (
    <div
      className={chromeRow}
      data-dictation-error
      role="alert"
    >
      <span className={cn(chromeLabelText, 'min-w-0 flex-1 truncate text-danger')}>{message}</span>
      {settingsSection && onOpenSettings ? (
        <button
          type="button"
          className={cn(chromePillButton, 'shrink-0 text-fg')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenSettings(settingsSection)}
        >
          {settingsActionLabel(settingsSection)}
        </button>
      ) : null}
      <button
        type="button"
        className={iconBtn}
        aria-label="Dismiss dictation error"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDismiss}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
