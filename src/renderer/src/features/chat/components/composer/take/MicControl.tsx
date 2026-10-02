import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@renderer/lib/icons'
import { Badge, Button, IconButton, MENU_SURFACE, ProgressBar, cn } from '@renderer/lib/ui'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { DICTATION_LOCAL_CATALOG } from '@shared/dictation'
import type { DictationEngine } from '@shared/ipc'
import type { TakeHandle } from './useTake'

/*
  The mic, and what opens from it. Pressing it with nothing set up opens
  "Dictate with" right here, and a refused microphone opens the switch that
  refused it — instead of an error banner with a Settings link picked by
  pattern-matching the message. At rest it is one quiet glyph, set up or not:
  a dot on it would ask for attention from everyone who never dictates.
*/

const PANEL_WIDTH_PX = 380

export function MicControl({ take }: { take: TakeHandle }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const open = take.panel !== null
  const { position } = useDropdownMenu({
    open,
    onOpenChange: (next) => {
      if (!next) take.setPanel(null)
    },
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'end',
    trapFocus: true,
    autoFocusFirst: true
  })

  const chord = shortcutLabel('dictation')
  const tip = `Dictate (${chord})\n${take.holdToTalk ? 'Hold to talk · ' : ''}${take.engineDetail}`

  let button: ReactNode
  switch (take.mic) {
    case 'live':
      button = (
        <IconButton
          ref={triggerRef}
          icon="mic"
          weight="fill"
          label={`Insert (${chord})`}
          size="md"
          active
          data-take-mic="live"
          onMouseDown={(e) => e.preventDefault()}
          onClick={take.actions.press}
        />
      )
      break
    case 'busy':
      button = (
        <IconButton
          ref={triggerRef}
          icon="loader"
          label="Finishing dictation"
          size="md"
          tone="muted"
          disabled
          aria-busy
          data-take-mic="busy"
          className="[&_svg]:motion-safe:animate-spin"
        />
      )
      break
    case 'blocked':
      button = (
        <IconButton
          ref={triggerRef}
          icon="micSlash"
          label="Microphone blocked — how to allow it"
          size="md"
          tone="inherit"
          className="text-warning"
          aria-expanded={open}
          aria-haspopup="dialog"
          data-take-mic="blocked"
          onMouseDown={(e) => e.preventDefault()}
          onClick={take.actions.press}
        />
      )
      break
    case 'setup':
      button = (
        <IconButton
          ref={triggerRef}
          icon="mic"
          label="Set up dictation"
          title={`Set up dictation (${chord})`}
          size="md"
          tone="muted"
          aria-expanded={open}
          aria-haspopup="dialog"
          data-take-mic="setup"
          onMouseDown={(e) => e.preventDefault()}
          onClick={take.actions.press}
        />
      )
      break
    case 'idle':
      button = (
        <IconButton
          ref={triggerRef}
          icon="mic"
          label="Dictate"
          title={tip}
          size="md"
          tone="muted"
          data-take-mic="idle"
          onPointerEnter={take.actions.warm}
          onFocus={take.actions.warm}
          onMouseDown={(e) => e.preventDefault()}
          onClick={take.actions.press}
        />
      )
      break
    default: {
      const _exhaustive: never = take.mic
      button = _exhaustive
    }
  }

  const panel =
    open && position
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={take.panel === 'setup' ? 'Dictate with' : 'Microphone blocked'}
            data-take-panel={take.panel ?? undefined}
            className={cn('fixed flex flex-col', position.placement === 'up' ? 'origin-bottom' : 'origin-top', MENU_SURFACE)}
            style={{
              width: PANEL_WIDTH_PX,
              left: Math.max(8, position.left - PANEL_WIDTH_PX),
              top: position.placement === 'up' ? undefined : position.top,
              bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined
            }}
          >
            {take.panel === 'setup' ? <SetupPanel take={take} /> : <BlockedPanel take={take} />}
          </div>,
          document.body
        )
      : null

  return (
    <>
      {button}
      {panel}
    </>
  )
}

function Choice({
  title,
  badge,
  detail,
  action,
  below
}: {
  title: string
  badge?: ReactNode
  detail: ReactNode
  action: ReactNode
  below?: ReactNode
}) {
  return (
    <div className="rounded-md px-2 py-2 hover:bg-surface">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
            {title}
            {badge}
          </div>
          <div className="mt-0.5 text-xs text-muted">{detail}</div>
        </div>
        <div className="shrink-0 pt-px">{action}</div>
      </div>
      {below ? <div className="mt-2">{below}</div> : null}
    </div>
  )
}

function CloudChoice({ take, engine, label }: { take: TakeHandle; engine: Exclude<DictationEngine, 'local'>; label: string }) {
  const hasKey = Boolean(take.secrets[engine])
  return (
    <Choice
      title={label}
      detail={hasKey ? `Uses your ${label} key · any language` : <span className="text-tertiary">{`No ${label} key yet`}</span>}
      action={
        hasKey ? (
          <Button size="xs" variant="secondary" onClick={() => void take.actions.useEngine(engine)}>
            Use
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => take.actions.openSettings('providers')}>
            Add key
          </Button>
        )
      }
    />
  )
}

/** First press with nothing set up: choose how dictation runs, right here. */
function SetupPanel({ take }: { take: TakeHandle }) {
  const runtime = take.runtime
  const modelId = runtime?.recommendedModelId ?? 'whisper-small.en'
  const model = DICTATION_LOCAL_CATALOG.find((m) => m.id === modelId) ?? DICTATION_LOCAL_CATALOG[0]!
  const installed = (runtime?.installed.length ?? 0) > 0
  const downloading = runtime?.phase === 'downloading' && runtime.activeModelId != null
  const loading = runtime?.phase === 'loading'
  const progress = runtime?.progress ?? null
  return (
    <div className="p-1">
      <div className="px-2 pb-1.5 pt-2">
        <div className="text-sm font-medium text-fg-strong">Dictate with</div>
        <div className="mt-0.5 text-xs text-muted">Pick one to start. Settings → Voice changes it later.</div>
      </div>
      <Choice
        title="This PC"
        badge={<Badge tone="outline">Recommended</Badge>}
        detail={`${model.label} · ${model.approxDownloadLabel.replace('~', '')} · ${model.language} · audio never leaves this PC`}
        action={
          installed ? (
            <Button size="xs" variant="secondary" onClick={() => void take.actions.useEngine('local')}>
              Use
            </Button>
          ) : (
            <Button
              size="xs"
              variant="secondary"
              pending={downloading || loading}
              onClick={() => void take.actions.installLocal()}
            >
              {downloading ? 'Installing' : 'Install'}
            </Button>
          )
        }
        below={
          downloading || loading ? (
            <div className="flex items-center gap-2">
              {progress != null ? (
                <ProgressBar value={progress} tone="accent" className="min-w-0 flex-1" label={`${model.label} download`} />
              ) : (
                <span className="min-w-0 flex-1 text-xs text-muted">{loading ? 'Loading the model' : 'Starting the download'}</span>
              )}
              {progress != null ? (
                <span className="shrink-0 font-mono text-caption text-tertiary tnum">{`${Math.round(progress * 100)}%`}</span>
              ) : null}
            </div>
          ) : take.installError ? (
            <span className="text-xs text-danger" role="alert">
              {take.installError}
            </span>
          ) : null
        }
      />
      <CloudChoice take={take} engine="openai" label="OpenAI" />
      <CloudChoice take={take} engine="openrouter" label="OpenRouter" />
      {downloading || loading ? (
        <div className={cn('mx-1 mb-1 mt-1 border-t px-1 pt-2 text-xs text-tertiary', BORDER_DIVIDER)}>
          Keep typing. The mic opens by itself when the model is ready.
        </div>
      ) : null}
    </div>
  )
}

/** A switch as a picture of what to set — not a control. */
function SwitchPicture() {
  return (
    <span aria-hidden="true" className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-accent">
      <span className="absolute left-[16px] size-3.5 rounded-full bg-bg" />
    </span>
  )
}

/** The microphone was refused: draw the switches that have to be on, and link straight to them. */
function BlockedPanel({ take }: { take: TakeHandle }) {
  const platform = typeof window !== 'undefined' ? window.vyotiq?.platform : undefined
  const rows =
    platform === 'darwin'
      ? { path: 'Privacy & Security › Microphone', switches: ['Agent V'] }
      : platform === 'win32'
        ? { path: 'Privacy & security › Microphone', switches: ['Microphone access', 'Let desktop apps access your microphone'] }
        : null
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
        <Icon name="micSlash" size={16} className="text-warning" />
        {platform === 'darwin' ? 'macOS is blocking the microphone' : platform === 'win32' ? 'Windows is blocking the microphone' : 'The microphone is blocked'}
      </div>
      {rows ? (
        <div className="mt-3 overflow-hidden rounded-md border border-border bg-sunken">
          <div className={cn('flex h-7 items-center gap-1.5 border-b px-3 text-caption text-tertiary', BORDER_DIVIDER)}>
            <Icon name="gear" size={12} />
            {rows.path}
          </div>
          {rows.switches.map((label) => (
            <div key={label} className="flex h-8 items-center gap-3 px-3">
              <span className="min-w-0 flex-1 truncate text-xs text-fg">{label}</span>
              <span className="text-caption text-tertiary">On</span>
              <SwitchPicture />
            </div>
          ))}
        </div>
      ) : (
        <p className="m-0 mt-2 text-xs text-muted">Allow microphone access for Agent V in your system settings.</p>
      )}
      <div className="mt-3 flex items-center gap-1.5">
        <span className="flex-1 text-xs text-tertiary">{rows ? (rows.switches.length > 1 ? 'Turn both on.' : 'Turn it on.') : ''}</span>
        <Button size="xs" variant="ghost" onClick={take.actions.tryAgain}>
          Try again
        </Button>
        {rows ? (
          <Button size="xs" variant="secondary" trailingIcon="external" onClick={take.actions.openMicSettings}>
            Open settings
          </Button>
        ) : null}
      </div>
    </div>
  )
}
