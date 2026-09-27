import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, cn } from '@renderer/lib/ui'
import type { DictationWaveformStyle } from '@shared/ipc'
import type { DictationPhase } from './useComposerDictation'
import { chromeLabelText, chromeRow } from './composerChrome'

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


const waveTrack = 'h-8 min-w-0 flex-1 overflow-hidden'

function amp(raw: number): number {
  return Math.max(0.06, Math.min(1, raw))
}

/** One value per output bar — the MAX of its source range so speech peaks survive downsampling. */
function pickSamples(samples: readonly number[], count: number): number[] {
  if (count <= 0) return []
  if (samples.length === 0) return Array.from({ length: count }, () => 0.08)
  if (samples.length <= count) return [...samples]
  const out = new Array<number>(count)
  const step = samples.length / count
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * step)
    const to = Math.max(from + 1, Math.floor((i + 1) * step))
    let peak = 0.08
    for (let j = from; j < to && j < samples.length; j++) {
      const v = samples[j] ?? 0
      if (v > peak) peak = v
    }
    out[i] = peak
  }
  return out
}

/**
 * Auto-gain: stretch a quiet signal across the full range so speech reads at a
 * glance. A flat signal (silence, reduced motion) falls back to its raw values
 * instead of being stretched into a solid block.
 */
function normalize(samples: readonly number[]): number[] {
  let min = Infinity
  let max = -Infinity
  for (const v of samples) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  if (!(range > 0.06)) return [...samples]
  return samples.map((v) => (v - min) / range)
}

type WaveformTone = 'text-accent' | 'text-muted'

function toneForPhase(phase: DictationPhase | undefined): WaveformTone {
  return phase === 'transcribing' ? 'text-muted' : 'text-accent'
}

/** Live waveform visualizer — shared by the inline dictation session and the error state. */
export function Waveform({
  samples,
  style,
  phase
}: {
  samples: readonly number[]
  style: DictationWaveformStyle
  /** Tones the bars: listening is accent, transcribing is muted. Omitted = recording tone. */
  phase?: DictationPhase
}) {
  const tone = toneForPhase(phase)
  switch (style) {
    case 'bars': {
      const bars = normalize(pickSamples(samples, 40))
      return (
        <div className={cn(waveTrack, tone, 'flex items-center gap-0.5')} aria-hidden>
          {bars.map((raw, i) => (
            <span
              key={i}
              className="min-w-px flex-1 basis-0 self-center rounded-sm bg-current"
              style={{ height: `${Math.round(3 + amp(raw) * 25)}px` }}
            />
          ))}
        </div>
      )
    }
    case 'dots': {
      const dots = normalize(pickSamples(samples, 36))
      return (
        <div
          className={cn(waveTrack, tone, 'flex items-center justify-between gap-px')}
          aria-hidden
        >
          {dots.map((raw, i) => {
            const px = Math.round(3 + amp(raw) * 13)
            return (
              <span
                key={i}
                className="shrink-0 rounded-full bg-current"
                style={{ width: `${px}px`, height: `${px}px` }}
              />
            )
          })}
        </div>
      )
    }
    case 'line': {
      const pts = normalize(pickSamples(samples, 48))
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
          className={cn(waveTrack, tone)}
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
      const bars = normalize(pickSamples(samples, 40))
      return (
        <div className={cn(waveTrack, tone, 'flex flex-col')} aria-hidden>
          <div className="flex h-1/2 items-end gap-0.5">
            {bars.map((raw, i) => (
              <span
                key={`t-${i}`}
                className="min-w-px flex-1 basis-0 rounded-t-sm bg-current"
                style={{ height: `${Math.round(2 + amp(raw) * 12)}px` }}
              />
            ))}
          </div>
          <div className="flex h-1/2 items-start gap-0.5 opacity-50">
            {bars.map((raw, i) => (
              <span
                key={`b-${i}`}
                className="min-w-px flex-1 basis-0 rounded-b-sm bg-current"
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

/** Live session row: glyph + state word + optional engine + waveform + elapsed. */
export function DictationSession({
  phase,
  elapsedMs,
  waveform,
  style,
  engineHint,
  className
}: {
  phase: 'checking' | 'recording' | 'transcribing'
  elapsedMs: number
  waveform: readonly number[]
  style: DictationWaveformStyle
  /** Optional engine name shown after the state word (e.g. `Whisper large-v3`). */
  engineHint?: string | null
  className?: string
}) {
  const sessionKind =
    phase === 'checking' ? 'checking' : phase === 'transcribing' ? 'transcribing' : 'listening'
  const glyph = phase === 'checking' ? 'loader' : phase === 'transcribing' ? 'waveform' : 'mic'
  const stateWord =
    phase === 'checking' ? 'Starting…' : phase === 'recording' ? 'Listening' : 'Transcribing'
  const statusLabel = phase === 'checking' ? 'Starting dictation' : stateWord
  return (
    <div
      className={cn('flex h-8 min-w-0 items-center gap-2', className)}
      role="status"
      aria-live="polite"
      aria-label={statusLabel}
      data-dictation-session={sessionKind}
    >
      <span
        className={cn('shrink-0', phase === 'recording' ? 'text-accent' : 'text-muted')}
        aria-hidden
      >
        <Icon name={glyph} size={14} />
      </span>
      <span
        className={cn(
          chromeLabelText,
          'shrink-0',
          phase === 'recording' ? 'text-accent' : 'text-muted'
        )}
      >
        {stateWord}
      </span>
      {engineHint ? (
        <span className="shrink-0 text-tertiary text-caption">{`${engineHint} ·`}</span>
      ) : null}
      <div className="min-w-0 flex-1">
        <Waveform samples={waveform} style={style} phase={phase} />
      </div>
      <span className="shrink-0 font-mono text-xs text-tertiary tnum">
        {formatElapsed(elapsedMs)}
      </span>
    </div>
  )
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
      <span className="shrink-0 text-danger" aria-hidden>
        <Icon name="warning" size={14} />
      </span>
      <span className={cn(chromeLabelText, 'min-w-0 flex-1 truncate text-danger')}>{message}</span>
      {settingsSection && onOpenSettings ? (
        <Button
          size="xs"
          variant="ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenSettings(settingsSection)}
        >
          {settingsActionLabel(settingsSection)}
        </Button>
      ) : null}
      <IconButton
        icon="close"
        label="Dismiss dictation error"
        size="sm"
        tone="muted"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDismiss}
      />
    </div>
  )
}
