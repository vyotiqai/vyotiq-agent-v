import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Badge, Button, IconButton, MENU_SURFACE, Tooltip, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { matchShortcut } from '@renderer/lib/shortcuts/match'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { STT_AUTO_ORDER, resolveSttProvider, sttEntry, type VoiceKeyAvailability } from '@shared/voice'
import type { VoiceKeyStatus, VoiceSettings } from '@shared/ipc/schemas/voice'
import { endVoiceMode, noteVoiceLineFocus, registerVoiceLine, startVoiceMode, takeArmedVoiceStart, useVoiceMode, voiceShortcutTarget } from './voiceMode'

const PANEL_WIDTH_PX = 360

/** Where "Add key" leads: voice keys live in Settings → Voice, chat keys in Providers. */
export type VoiceSetupTarget = 'voice' | 'providers'

function availability(status: VoiceKeyStatus): VoiceKeyAvailability {
  const voice: Record<string, boolean> = {}
  for (const [vendor, state] of Object.entries(status.voice)) voice[vendor] = Boolean(state?.set)
  return { voice, chat: status.chat }
}

/**
 * Whether a listener can open with the keys there are now. Unknown (an old
 * preload, a failed read) counts as yes: the session then says what's wrong.
 */
async function listenerReady(settings: VoiceSettings): Promise<boolean> {
  const res = await window.vyotiq?.voiceKeyStatus?.()
  if (!res?.ok) return true
  return resolveSttProvider(settings.sttProvider, availability(res.data)).ok
}

/**
 * Starts voice mode on this instruction line (docs/voice-mode.md §13.5).
 * Sits beside dictation's mic: the mic types what you say, this talks with
 * the agent. Ctrl/Cmd+Shift+M and the palette's "Voice mode" reach the line
 * you last used, so a split view doesn't start two sessions.
 *
 * With no listening service set up, pressing it opens "Talk with" right here
 * (§9.5) instead of starting a session that can only fail.
 */
export function VoiceModeButton({
  owner,
  workspacePath,
  disabled,
  placement = 'up',
  onOpenSettings
}: {
  owner: string
  workspacePath: string | null
  disabled?: boolean
  placement?: 'up' | 'down'
  /** Settings → Voice (or Providers, for an OpenAI key) from "Add key". */
  onOpenSettings?: (section: VoiceSetupTarget) => void
}) {
  const { owner: active, settings } = useVoiceMode()
  const on = active === owner
  const [setupOpen, setSetupOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const { position, close } = useDropdownMenu({
    open: setupOpen,
    onOpenChange: setSetupOpen,
    triggerRef,
    panelRef,
    placement,
    align: 'end',
    trapFocus: true,
    autoFocusFirst: true
  })

  const toggle = (): void => {
    if (disabled) return
    if (on) {
      void endVoiceMode()
      return
    }
    void listenerReady(settings).then((ready) => {
      if (ready) void startVoiceMode(owner, { workspacePath })
      else setSetupOpen(true)
    })
  }
  // The shortcut and the palette reach this line through a listener set up once per change.
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  useEffect(() => {
    const unregister = registerVoiceLine(owner)
    // Asked for from Home or Settings: this New task line is where it starts.
    if (takeArmedVoiceStart()) toggleRef.current()
    return unregister
  }, [owner])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!matchShortcut(e, 'voiceMode')) return
      if (voiceShortcutTarget() !== owner) return
      e.preventDefault()
      toggleRef.current()
    }
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent<{ id?: string }>).detail?.id !== 'voiceMode') return
      if (voiceShortcutTarget() === owner) toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('vyotiq:command', onCommand)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('vyotiq:command', onCommand)
    }
  }, [owner])

  const label = on ? 'End voice mode' : 'Talk with the agent'
  const panel =
    setupOpen && position
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Talk with"
            data-voice-setup
            className={cn('fixed flex flex-col', position.placement === 'up' ? 'origin-bottom' : 'origin-top', MENU_SURFACE)}
            style={{
              width: PANEL_WIDTH_PX,
              left: Math.max(8, position.left - PANEL_WIDTH_PX),
              top: position.placement === 'up' ? undefined : position.top,
              bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined
            }}
          >
            <VoiceSetupPanel
              onAddKey={
                onOpenSettings
                  ? (section) => {
                      close()
                      onOpenSettings(section)
                    }
                  : undefined
              }
            />
          </div>,
          document.body
        )
      : null

  return (
    <>
      <Tooltip content={`${label} (${shortcutLabel('voiceMode')})`}>
        <IconButton
          ref={triggerRef}
          icon="waveform"
          label={label}
          size="sm"
          tone="muted"
          active={on}
          aria-pressed={on}
          aria-expanded={setupOpen || undefined}
          disabled={disabled}
          data-voice-button={on ? 'on' : 'off'}
          onFocus={() => noteVoiceLineFocus(owner)}
          onClick={() => {
            noteVoiceLineFocus(owner)
            toggle()
          }}
        />
      </Tooltip>
      {panel}
    </>
  )
}

/** First press with no listening service: what each one is, and the way to add its key. */
function VoiceSetupPanel({ onAddKey }: { onAddKey?: (section: VoiceSetupTarget) => void }) {
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <Icon name="waveform" size={14} className="text-muted" />
        <span className="text-sm font-medium text-fg-strong">Talk with</span>
      </div>
      <div className="p-1">
        <p className="m-0 px-2 pb-1.5 pt-2 text-xs text-muted">
          Voice mode needs a key for one listening service, or This PC. Settings → Voice changes it later.
        </p>
        {/* This PC needs no key. It's never picked automatically (slower), so it's chosen there (2026-10-16 audit 3, A10). */}
        {[...STT_AUTO_ORDER, 'local' as const].map((id, index) => {
          const entry = sttEntry(id)
          const section: VoiceSetupTarget = entry.key.kind === 'chat' ? 'providers' : 'voice'
          const keyless = entry.key.kind === 'none'
          return (
            <div key={id} className={cn('flex items-start gap-3 rounded-md px-2 py-2', ROW_HOVER)} data-voice-setup-choice={id}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
                  {entry.label}
                  {index === 0 ? <Badge tone="outline">Recommended</Badge> : null}
                </div>
                <div className="mt-0.5 text-xs text-muted">{`${entry.trait} · ${entry.privacy}`}</div>
              </div>
              {onAddKey ? (
                <div className="shrink-0 pt-px">
                  <Button size="xs" variant={index === 0 ? 'secondary' : 'ghost'} onClick={() => onAddKey(section)}>
                    {keyless ? 'Choose' : 'Add key'}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </>
  )
}
