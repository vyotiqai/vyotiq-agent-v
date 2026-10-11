import { useEffect } from 'react'
import { IconButton, Tooltip } from '@renderer/lib/ui'
import { matchShortcut } from '@renderer/lib/shortcuts/match'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { endVoiceMode, noteVoiceLineFocus, registerVoiceLine, startVoiceMode, useVoiceMode, voiceShortcutTarget } from './voiceMode'

/**
 * Starts voice mode on this instruction line (docs/voice-mode.md §13.5).
 * Sits beside dictation's mic: the mic types what you say, this talks with
 * the agent. Ctrl/Cmd+Shift+M and the palette's "Voice mode" reach the line
 * you last used, so a split view doesn't start two sessions.
 */
export function VoiceModeButton({
  owner,
  workspacePath,
  disabled
}: {
  owner: string
  workspacePath: string | null
  disabled?: boolean
}) {
  const { owner: active } = useVoiceMode()
  const on = active === owner

  useEffect(() => registerVoiceLine(owner), [owner])

  useEffect(() => {
    const toggle = (): void => {
      if (disabled || voiceShortcutTarget() !== owner) return
      if (on) void endVoiceMode()
      else void startVoiceMode(owner, { workspacePath })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!matchShortcut(e, 'voiceMode')) return
      if (voiceShortcutTarget() !== owner) return
      e.preventDefault()
      toggle()
    }
    const onCommand = (e: Event): void => {
      if ((e as CustomEvent<{ id?: string }>).detail?.id === 'voiceMode') toggle()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('vyotiq:command', onCommand)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('vyotiq:command', onCommand)
    }
  }, [owner, workspacePath, on, disabled])

  const label = on ? 'End voice mode' : 'Talk with the agent'
  return (
    <Tooltip content={`${label} (${shortcutLabel('voiceMode')})`}>
      <IconButton
        icon="waveform"
        label={label}
        size="sm"
        tone="muted"
        active={on}
        aria-pressed={on}
        disabled={disabled}
        data-voice-button={on ? 'on' : 'off'}
        onFocus={() => noteVoiceLineFocus(owner)}
        onClick={() => {
          noteVoiceLineFocus(owner)
          if (on) void endVoiceMode()
          else void startVoiceMode(owner, { workspacePath })
        }}
      />
    </Tooltip>
  )
}
