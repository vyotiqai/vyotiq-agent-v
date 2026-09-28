import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { ActionMenu, Button, Keys, ProgressBar, cn, type ActionMenuItem } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import type { DictationEngine } from '@shared/ipc'
import { ENGINE_LABEL } from './dictationStore'
import type { TakeSnapshot } from './takeController'
import type { TakeHandle } from './useTake'

/*
  The take strip: while a take is open it stands in for the composer's
  control row — the same row on the instruction line, the brief and
  edit-and-rerun, with the mic still at its end. Lead glyph · meter · time ·
  where the audio goes · (message) · the ways out, right-aligned. Every state
  is a row of the same shape, so the eye learns one place.
*/

const ENGINE_ICON: Record<DictationEngine, IconName> = { local: 'lock', openai: 'cloud', openrouter: 'cloud' }
const ENGINE_PRIVACY: Record<DictationEngine, string> = {
  local: 'Audio stays on this PC',
  openai: 'Audio is sent to OpenAI with your key',
  openrouter: 'Audio is sent to OpenRouter with your key'
}

function modKey(): string {
  return typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin' ? '⌘' : 'Ctrl'
}

export function formatTakeTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

/** Where the audio goes. Said once per take, here. */
export function EngineToken({ engine }: { engine: DictationEngine }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-caption text-tertiary @max-[420px]:hidden"
      title={ENGINE_PRIVACY[engine]}
    >
      <Icon name={ENGINE_ICON[engine]} size={12} />
      {ENGINE_LABEL[engine]}
      <span className="sr-only">{`, ${ENGINE_PRIVACY[engine]}`}</span>
    </span>
  )
}

/** The last few seconds of loudness, newest on the right: shows the mic is alive, and your pauses. */
export function LevelMeter({ levels, live }: { levels: readonly number[]; live: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-take-meter
      className={cn(
        // A split pane: fewer bars under 360px, none under 300px (the live dot still says it hears you).
        'flex h-4 w-[110px] shrink-0 items-center justify-end gap-[2px] overflow-hidden @max-[360px]:w-12 @max-[300px]:hidden',
        live ? 'text-accent' : 'text-tertiary'
      )}
    >
      {levels.map((v, i) => (
        <span
          key={i}
          className="w-[2px] shrink-0 rounded-full bg-current"
          style={{ height: `${Math.max(2, Math.round(Math.min(1, v) * 16))}px` }}
        />
      ))}
    </span>
  )
}

function Time({ ms, warn = false, suffix }: { ms: number; warn?: boolean; suffix?: string }) {
  return (
    // Hidden from the live region around it: a ticking clock would be read out every second.
    <span
      aria-hidden="true"
      className={cn('shrink-0 font-mono text-xs tnum @max-[300px]:hidden', warn ? 'text-warning' : 'text-secondary')}
    >
      {formatTakeTime(ms)}
      {suffix}
    </span>
  )
}

/** Left-aligned in its 16px cell, so the glyph sits on the field's text edge. */
function Lead({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-4 shrink-0 items-center" aria-hidden="true">
      {children}
    </span>
  )
}

function RecDot({ hollow = false }: { hollow?: boolean }) {
  return (
    <Lead>
      <span className={cn('size-2 rounded-full', hollow ? 'border border-border-strong' : 'animate-live bg-accent')} />
    </Lead>
  )
}

function LeadIcon({ name, tone }: { name: IconName; tone: 'muted' | 'success' | 'danger' | 'warning' }) {
  const color =
    tone === 'muted' ? 'text-muted' : tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-warning'
  return (
    <Lead>
      <Icon name={name} size={14} className={cn(color, name === 'loader' ? 'motion-safe:animate-spin' : undefined)} />
    </Lead>
  )
}

/** "Change mic": the audio inputs, the one in use checked. */
function DeviceMenu({ take }: { take: TakeHandle }) {
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  const items: ActionMenuItem[] =
    devices.length > 0
      ? devices.map((d) => ({
          id: d.deviceId || 'default',
          label: d.label,
          checked: d.deviceId === take.deviceId,
          onSelect: () => take.actions.switchDevice(d.deviceId)
        }))
      : [{ id: 'none', label: 'No other microphone', disabled: true, onSelect: () => undefined }]
  return (
    <ActionMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void take.actions.listDevices().then(setDevices)
      }}
      placement="up"
      align="end"
      aria-label="Microphones"
      items={items}
      trigger={(t) => (
        <Button
          ref={t.ref}
          size="xs"
          variant="ghost"
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onMouseDown={(e) => e.preventDefault()}
          onClick={t.onClick}
        >
          Change mic
        </Button>
      )}
    />
  )
}

/** Buttons never take focus from the field on press: the take is driven by keys too. */
function Act({
  children,
  onClick,
  kbd,
  primary = false,
  icon
}: {
  children: ReactNode
  onClick: () => void
  kbd?: string[]
  primary?: boolean
  icon?: IconName
}) {
  return (
    <Button
      size="xs"
      variant={primary ? 'secondary' : 'ghost'}
      kbd={kbd}
      icon={icon}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function ListeningActions({ take, sendLabel }: { take: TakeHandle; sendLabel: string | null }) {
  const sendFirst = take.enterAction === 'send' && sendLabel != null
  const enter = ['↵']
  const modEnter = [modKey(), '↵']
  return (
    <>
      <Act onClick={take.actions.discard} kbd={['Esc']}>
        Discard
      </Act>
      {sendLabel ? (
        <Act onClick={take.actions.send} kbd={sendFirst ? enter : modEnter} primary={sendFirst}>
          {sendLabel}
        </Act>
      ) : null}
      <Act onClick={take.actions.insert} kbd={sendFirst ? modEnter : enter} primary={!sendFirst}>
        Insert
      </Act>
    </>
  )
}

function TakeBody({ take, snap, sendLabel }: { take: TakeHandle; snap: TakeSnapshot; sendLabel: string | null }) {
  switch (snap.phase) {
    case 'idle':
      return null
    case 'starting':
      return (
        <>
          <RecDot hollow />
          <LevelMeter levels={snap.levels} live={false} />
          <span className="text-muted">Opening the mic</span>
          <span className="flex-1" />
          <EngineToken engine={snap.engine} />
        </>
      )
    case 'listening':
      if (snap.hold) {
        return (
          <>
            <RecDot />
            <span className="sr-only">Listening</span>
            <LevelMeter levels={snap.levels} live />
            <Time ms={snap.elapsedMs} />
            <EngineToken engine={snap.engine} />
            <span className="flex-1" />
            <span className="flex shrink-0 items-center gap-1.5 text-muted">
              Release
              <Keys keys={shortcutLabel('dictation').split('+')} />
              to insert
            </span>
          </>
        )
      }
      if (snap.silent) {
        return (
          <>
            <RecDot hollow />
            <LevelMeter levels={snap.levels} live={false} />
            <Time ms={snap.elapsedMs} />
            <span className="flex min-w-0 items-center gap-1.5 text-warning" role="alert">
              <Icon name="warningCircle" size={13} />
              <span className="min-w-0 truncate">
                {snap.deviceLabel ? `Nothing heard from ${snap.deviceLabel}` : 'Nothing heard from the microphone'}
              </span>
            </span>
            <span className="flex-1" />
            <DeviceMenu take={take} />
            <Act onClick={take.actions.discard} kbd={['Esc']}>
              Discard
            </Act>
          </>
        )
      }
      return (
        <>
          <RecDot />
          <span className="sr-only">Listening</span>
          <LevelMeter levels={snap.levels} live />
          <Time ms={snap.elapsedMs} />
          {snap.leftMs != null ? <Time ms={snap.leftMs} warn suffix=" left" /> : null}
          {snap.failure ? (
            // A segment failed mid-take: say so now, not after the speaking is done.
            // The audio is kept; finishing offers Retry.
            <span className="flex min-w-0 items-center gap-1.5 text-danger" role="alert" title={snap.failure.message}>
              <Icon name="xCircle" size={13} />
              <span className="min-w-0 truncate">{snap.failure.message}</span>
            </span>
          ) : (
            <EngineToken engine={snap.engine} />
          )}
          <span className="flex-1" />
          <ListeningActions take={take} sendLabel={sendLabel} />
        </>
      )
    case 'finishing':
      return (
        <>
          <LeadIcon name="loader" tone="muted" />
          <LevelMeter levels={snap.levels} live={false} />
          <Time ms={snap.elapsedMs} />
          <span className="shrink-0 text-muted">Finishing</span>
          {snap.progress != null ? (
            <ProgressBar value={snap.progress} tone="accent" className="w-16" label="Transcription progress" />
          ) : null}
          <EngineToken engine={snap.engine} />
          <span className="flex-1" />
          <Act onClick={take.actions.discard} kbd={['Esc']}>
            Discard
          </Act>
        </>
      )
    case 'failed': {
      const failure = snap.failure
      const code = failure?.code
      const nothing = code === 'nothing_heard'
      return (
        <>
          <LeadIcon name={nothing ? 'warningCircle' : 'xCircle'} tone={nothing ? 'warning' : 'danger'} />
          <span className={cn('min-w-0 truncate', nothing ? 'text-warning' : 'text-danger')} title={failure?.message} role="alert">
            {failure?.message ?? 'Transcription failed'}
          </span>
          {nothing ? null : (
            <span className="shrink-0 text-tertiary">
              · <span className="font-mono tnum">{formatTakeTime(snap.elapsedMs)}</span> kept
            </span>
          )}
          <span className="flex-1" />
          <Act onClick={take.actions.discard} kbd={['Esc']}>
            Discard
          </Act>
          {code === 'no_key' ? (
            <Act onClick={() => take.actions.openSettings('providers')} icon="key">
              Add key
            </Act>
          ) : null}
          {code === 'rejected_key' ? (
            <Act onClick={() => take.actions.openSettings('providers')} icon="key">
              Providers
            </Act>
          ) : null}
          {code === 'model_missing' ? (
            <Act onClick={() => take.setPanel('setup')} icon="download">
              Install
            </Act>
          ) : null}
          {nothing ? <DeviceMenu take={take} /> : null}
          {take.fallback && !nothing ? (
            <Act onClick={() => take.actions.retry(take.fallback!)}>{`Try ${ENGINE_LABEL[take.fallback]}`}</Act>
          ) : null}
          {snap.keptWords > 0 ? (
            <Act onClick={take.actions.keep}>{`Insert ${snap.keptWords} ${snap.keptWords === 1 ? 'word' : 'words'}`}</Act>
          ) : null}
          {nothing ? null : (
            <Act onClick={() => take.actions.retry()} icon="retry" primary>
              Retry
            </Act>
          )}
        </>
      )
    }
    case 'discarded':
      return (
        <>
          <LeadIcon name="trash" tone="muted" />
          <span className="text-muted">
            Discarded a <span className="font-mono tnum">{formatTakeTime(snap.elapsedMs)}</span> take
          </span>
          <span className="flex-1" />
          <Act onClick={take.actions.restore}>Restore</Act>
        </>
      )
    default: {
      const _exhaustive: never = snap.phase
      return _exhaustive
    }
  }
}

export function TakeStrip({
  take,
  sendLabel,
  className
}: {
  take: TakeHandle
  /** The Ctrl+Enter verb here ("Send", "Queue", "Rerun"); null where inserting is the only way out. */
  sendLabel: string | null
  className?: string
}) {
  const view = take.view
  if (!view) return null
  const open =
    view.kind === 'take' &&
    (view.snap.phase === 'starting' ||
      view.snap.phase === 'listening' ||
      view.snap.phase === 'finishing' ||
      view.snap.phase === 'failed')
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Dictation"
      data-take={view.kind === 'take' ? view.snap.phase : view.kind}
      data-take-open={open ? '' : undefined}
      className={cn('flex h-8 min-w-0 items-center gap-2 text-xs', className)}
    >
      {view.kind === 'take' ? <TakeBody take={take} snap={view.snap} sendLabel={sendLabel} /> : null}
      {view.kind === 'inserted' ? (
        <>
          <LeadIcon name="check" tone="success" />
          <span className="text-secondary">
            <span className="font-mono tnum">{view.words}</span> {view.words === 1 ? 'word' : 'words'} inserted
          </span>
          <span className="flex-1" />
          <Act onClick={take.actions.undo} kbd={[modKey(), 'Z']}>
            Undo
          </Act>
        </>
      ) : null}
      {view.kind === 'mic_error' ? (
        <>
          <LeadIcon name="warningCircle" tone="warning" />
          <span className="min-w-0 truncate text-warning" role="alert">
            {view.message}
          </span>
          <span className="flex-1" />
          <DeviceMenu take={take} />
          <Act onClick={take.actions.dismissMicError}>Dismiss</Act>
        </>
      ) : null}
    </div>
  )
}
