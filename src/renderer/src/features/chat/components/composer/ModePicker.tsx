import { useCallback, useEffect, useRef } from 'react'
import { Tooltip } from '@renderer/lib/ui/Tooltip'
import { cn } from '@renderer/lib/ui/cn'
import type { AgentInteractionMode } from '@shared/ipc'
import {
  isMainComposerTarget,
  matchShortcut,
  shouldBlockAppShortcut,
  shortcutLabel
} from '@renderer/lib/shortcuts'
import { chromePillButton } from './composerChrome'

const MODES: { value: AgentInteractionMode; label: string; short: string }[] = [
  { value: 'ask', label: 'Ask', short: 'Ask' },
  { value: 'plan', label: 'Plan', short: 'Plan' },
  { value: 'agent', label: 'Agent', short: 'Agent' }
]

function nextMode(current: AgentInteractionMode, reverse: boolean): AgentInteractionMode {
  const i = MODES.findIndex((m) => m.value === current)
  const idx = i >= 0 ? i : 2
  const len = MODES.length
  const next = reverse ? (idx - 1 + len) % len : (idx + 1) % len
  return MODES[next]!.value
}

export function ModePicker({
  mode,
  onModeChange,
  disabled,
  running = false,
  className
}: {
  mode: AgentInteractionMode
  onModeChange: (mode: AgentInteractionMode) => void
  disabled?: boolean
  running?: boolean
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const advance = useCallback(
    (reverse: boolean) => {
      onModeChange(nextMode(mode, reverse))
    },
    [mode, onModeChange]
  )

  const locked = Boolean(disabled || running)

  useEffect(() => {
    if (locked) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (!matchShortcut(e, 'cycleMode')) return
      if (shouldBlockAppShortcut(e.target)) return
      const root = rootRef.current
      if (!root) return
      const shell = root.closest('[data-composer-shell]')
      const target = e.target instanceof Node ? e.target : null
      const inThisShell = Boolean(target && shell?.contains(target))
      if (isMainComposerTarget(target) || inThisShell) {
        if (!inThisShell) return
      } else {
        const pane = root.closest('[data-chat-pane]')
        if (pane?.getAttribute('data-chat-pane-focused') === '0') return
      }
      e.preventDefault()
      advance(e.shiftKey)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, advance])

  useEffect(() => {
    if (locked) return undefined
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== 'cycleMode') return
      advance(false)
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [locked, advance])

  const current = MODES.find((m) => m.value === mode) ?? MODES[2]!
  const upcoming = MODES.find((m) => m.value === nextMode(mode, false))!
  const chord = shortcutLabel('cycleMode')

  const ariaLabel = running
    ? `${current.label} mode (locked while running)`
    : `${current.label} mode. Click for ${upcoming.label}.`

  const tip = running ? ariaLabel : `${ariaLabel} Shift-click or ${chord} (Shift for previous).`
  const button = (
    <button
      type="button"
      disabled={locked}
      aria-label={ariaLabel}
      className={cn(chromePillButton, 'text-fg')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault()
        if (locked) return
        advance(e.shiftKey)
      }}
    >
      <span className="leading-tight">{current.short}</span>
    </button>
  )

  return (
    <div ref={rootRef} className={cn('relative flex h-7 shrink-0 items-center', className)}>
      {/* Disabled buttons ignore pointer events — wrap so hover still shows why. */}
      {locked ? (
        <Tooltip content={tip}>
          <span className="inline-grid cursor-not-allowed" aria-disabled="true">
            {button}
          </span>
        </Tooltip>
      ) : (
        <Tooltip content={tip}>{button}</Tooltip>
      )}
    </div>
  )
}
