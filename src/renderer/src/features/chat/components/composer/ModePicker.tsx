import { useEffect, useRef, type RefObject } from 'react'
import type { AgentInteractionMode } from '@shared/ipc'
import { Segmented } from '@renderer/lib/ui'
import {
  COMPOSER_MESSAGE_SELECTOR,
  isMainComposerTarget,
  matchShortcut,
  shortcutLabel,
  shouldBlockAppShortcut
} from '@renderer/lib/shortcuts'

/** The two modes, Agent first: it is what a task usually is. */
export const MODES: { value: AgentInteractionMode; label: string; note: string }[] = [
  { value: 'agent', label: 'Agent', note: 'Plans, edits files and runs commands' },
  { value: 'ask', label: 'Ask', note: 'Reads and answers — changes nothing' }
]

/**
 * Agent | Ask, first in the composer's control row. Both words show, so the
 * other mode is one press away and never hidden in a menu; Ctrl+. flips it,
 * and so does Shift+Tab in an empty box.
 */
export function ModeSwitch({
  mode,
  onChange,
  disabled = false
}: {
  mode: AgentInteractionMode
  onChange: (mode: AgentInteractionMode) => void
  disabled?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useCycleModeShortcut(rootRef, disabled, (reverse) => onChange(nextMode(mode, reverse)))
  const chord = shortcutLabel('cycleMode')
  return (
    <div ref={rootRef} className="flex shrink-0" data-mode-switch>
      <Segmented
        label="Mode"
        value={mode}
        items={MODES.map((m) => ({ id: m.value, label: m.label, title: `${m.note} (${chord}, or ⇧Tab in an empty box, switches)` }))}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  )
}

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
 * Shift+Tab in this composer's empty box. Only empty: once there is text,
 * Shift+Tab moves focus back as everywhere else, so the key never stops
 * someone leaving the box by keyboard while they are writing.
 */
function isShiftTabInEmptyBox(e: KeyboardEvent, shell: Element | null): boolean {
  if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
  const target = e.target instanceof Element ? e.target : null
  if (!target || !shell?.contains(target)) return false
  // The message box only: a brief's empty "Done when" field keeps Shift+Tab.
  const box = target.closest<HTMLElement>(COMPOSER_MESSAGE_SELECTOR)
  if (!box) return false
  // Its text, chips included: a mention or a picked element counts as typing.
  const text = box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement ? box.value : box.textContent
  return !text?.trim()
}

/**
 * Ctrl+. cycles the mode (Shift for previous) — in this composer when focus is
 * inside it, otherwise in the focused pane's composer; Shift+Tab does it in
 * this composer's empty box. The command palette's "cycleMode" command lands
 * here too.
 */
export function useCycleModeShortcut(
  rootRef: RefObject<HTMLElement | null>,
  locked: boolean,
  advance: (reverse: boolean) => void
): void {
  useEffect(() => {
    if (locked) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (isShiftTabInEmptyBox(e, rootRef.current?.closest('[data-composer-shell]') ?? null)) {
        e.preventDefault()
        advance(false)
        return
      }
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
      // Split panes: only the focused pane's mode changes, as with Ctrl+.
      const pane = rootRef.current?.closest('[data-chat-pane]')
      if (pane?.getAttribute('data-chat-pane-focused') === '0') return
      advance(false)
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [rootRef, locked, advance])
}
