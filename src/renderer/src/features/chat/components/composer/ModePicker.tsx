import { useEffect, type RefObject } from 'react'
import type { AgentInteractionMode } from '@shared/ipc'
import { isMainComposerTarget, matchShortcut, shouldBlockAppShortcut } from '@renderer/lib/shortcuts'

/** The two modes, as TaskOptions' Mode control and the New task brief list them. */
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
