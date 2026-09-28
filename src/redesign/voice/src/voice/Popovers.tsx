import type { ReactNode } from 'react'
import { Badge, Button, Keys, MENU_SURFACE, ProgressBar, Switch, cn } from '@renderer/lib/ui'
import { VIcon, type VoiceIconName } from '../lib/icons'
import { EngineToken } from './Take'

/*
  What opens from the mic. Drawn in place (not portalled) so a static frame
  can show them; in the app they are the ordinary MENU_SURFACE popover.
*/

/** The mic's tooltip: the verb and its chord, then where the audio goes. */
export function MicTip() {
  return (
    <div className="whitespace-nowrap rounded-md border border-border bg-card px-2 py-1.5 text-xs text-fg shadow-menu">
      <div className="flex items-center gap-2">
        <span>Dictate</span>
        <Keys keys={['Ctrl', 'M']} />
      </div>
      <div className="mt-1 flex items-center gap-2 text-tertiary">
        <span>Hold to talk</span>
        <span aria-hidden="true">·</span>
        <EngineToken engine="local" />
      </div>
    </div>
  )
}

function Choice({
  icon,
  title,
  badge,
  detail,
  action,
  below,
  selected = false
}: {
  icon: VoiceIconName
  title: string
  badge?: ReactNode
  detail: ReactNode
  action: ReactNode
  below?: ReactNode
  selected?: boolean
}) {
  return (
    <div className={cn('rounded-md px-2 py-2', selected ? 'bg-surface-2' : 'hover:bg-surface')}>
      <div className="flex items-start gap-2.5">
        <VIcon name={icon} size={16} className="mt-0.5 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
            {title}
            {badge}
          </div>
          <div className="mt-0.5 text-xs text-muted">{detail}</div>
        </div>
        <div className="shrink-0 pt-px">{action}</div>
      </div>
      {below ? <div className="mt-2 pl-[26px]">{below}</div> : null}
    </div>
  )
}

/**
 * First press with nothing set up: choose, right here, how dictation runs.
 * Replaces the old path — an error banner, a regex over its text to guess
 * which Settings page to open, then finding the model rows on that page.
 */
export function SetupPopover({ installing = null }: { installing?: number | null }) {
  const mb = installing != null ? Math.round(249 * installing) : 0
  return (
    <div className={cn(MENU_SURFACE, 'w-[380px] p-1')} role="dialog" aria-label="Set up dictation">
      <div className="px-2 pb-1.5 pt-2">
        <div className="text-sm font-medium text-fg-strong">Dictate with</div>
        <div className="mt-0.5 text-xs text-muted">Pick one to start. Settings → Voice changes it later.</div>
      </div>
      <Choice
        icon="lock"
        title="This PC"
        badge={<Badge tone="outline">Recommended</Badge>}
        detail="Whisper Small · 249 MB · English · audio never leaves this PC"
        selected={installing != null}
        action={
          installing != null ? (
            <Button size="xs" variant="ghost">
              Cancel
            </Button>
          ) : (
            <Button size="xs" variant="secondary" icon="download">
              Install
            </Button>
          )
        }
        below={
          installing != null ? (
            <div className="flex items-center gap-2">
              <ProgressBar value={installing} tone="accent" className="min-w-0 flex-1" label="Whisper Small download" />
              <span className="shrink-0 font-mono text-caption text-tertiary tnum">{`${mb} / 249 MB`}</span>
            </div>
          ) : null
        }
      />
      <Choice
        icon="cloud"
        title="OpenAI"
        detail="Uses your OpenAI key · any language"
        action={
          <Button size="xs" variant="secondary">
            Use
          </Button>
        }
      />
      <Choice
        icon="cloud"
        title="OpenRouter"
        detail={<span className="text-tertiary">No OpenRouter key yet</span>}
        action={
          <Button size="xs" variant="ghost" icon="key">
            Add key
          </Button>
        }
      />
      {installing != null ? (
        <div className="mx-1 mb-1 mt-1 border-t border-border/60 px-1 pt-2 text-xs text-tertiary">
          Keep typing. The mic opens by itself when the model is ready.
        </div>
      ) : null}
    </div>
  )
}

/** The two Windows switches that have to be on, drawn rather than described. */
function WindowsSwitchRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex h-8 items-center gap-3 px-3">
      <span className="min-w-0 flex-1 truncate text-xs text-fg">{label}</span>
      <span className="text-caption text-tertiary">{on ? 'On' : 'Off'}</span>
      <Switch checked={on} onCheckedChange={() => undefined} label={label} />
    </div>
  )
}

/** Mic permission refused: say which switch, draw it, and link straight to it. */
export function BlockedPopover() {
  return (
    <div className={cn(MENU_SURFACE, 'w-[380px] p-3')} role="dialog" aria-label="Microphone blocked">
      <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
        <VIcon name="micSlash" size={16} className="text-warning" />
        Windows is blocking the microphone
      </div>
      <div className="mt-3 overflow-hidden rounded-md border border-border bg-sunken">
        <div className="flex h-7 items-center gap-1.5 border-b border-border/60 px-3 text-caption text-tertiary">
          <VIcon name="gear" size={12} />
          Privacy &amp; security › Microphone
        </div>
        <WindowsSwitchRow label="Microphone access" on />
        <WindowsSwitchRow label="Let desktop apps access your microphone" on={false} />
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <span className="flex-1 text-xs text-tertiary">Turn the second one on.</span>
        <Button size="xs" variant="ghost">
          Try again
        </Button>
        <Button size="xs" variant="secondary" trailingIcon="external">
          Open settings
        </Button>
      </div>
    </div>
  )
}
