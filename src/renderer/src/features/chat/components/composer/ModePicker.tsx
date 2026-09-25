import { useCallback, useEffect, useRef, type RefObject } from 'react'
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

export const MODES: { value: AgentInteractionMode; label: string; short: string }[] = [
  { value: 'ask', label: 'Ask', short: 'Ask' },
  { value: 'agent', label: 'Agent', short: 'Agent' }
]

/** Index of `agent` in MODES — the fallback for an unrecognized mode. */
const DEFAULT_MODE_INDEX = MODES.findIndex((m) => m.value === 'agent')

export function nextMode(current: AgentInteractionMode, reverse: boolean): AgentInteractionMode {
  const i = MODES.findIndex((m) => m.value === current)
  const idx = i >= 0 ? i : DEFAULT_MODE_INDEX
  const len = MODES.length
  const next = reverse ? (idx - 1 + len) % len : (idx + 1) % len
  return MODES[next]!.value
}

/**
 * Ctrl+. cycles the mode (Shift for previous) — in this composer when focus is
 * inside it, otherwise in the focused pane's composer. The command palette's
 * "cycleMode" command lands here too.
 */
export function useCycleModeShortcut(
  rootRef: RefObject<HTMLElement | null>,
  locked: boolean,
  advance: (reverse: boolean) => void
): void {
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
  }, [rootRef, locked, advance])

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
  /** Settings can change for the next invocation while the current run continues. */
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

  const locked = Boolean(disabled)
  useCycleModeShortcut(rootRef, locked, advance)

  const current = MODES.find((m) => m.value === mode) ?? MODES[DEFAULT_MODE_INDEX]!
  const upcoming = MODES.find((m) => m.value === nextMode(mode, false))!
  const chord = shortcutLabel('cycleMode')

  const ariaLabel = `${current.label} mode. Click for ${upcoming.label}.`
  const tip = running
    ? `${ariaLabel} Changes apply to the next message while this run continues. Shift-click or ${chord} (Shift for previous).`
    : `${ariaLabel} Shift-click or ${chord} (Shift for previous).`
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
