import type { KeyboardEvent } from 'react'
import type { ToolApprovalMode } from '@shared/ipc'
import { cn } from '@renderer/lib/ui'

type ModeCopy = { mode: ToolApprovalMode; label: string; description: string }

/**
 * The three approval modes in the words the Set up page and the first-send
 * question both use. "Unattended" is not "nothing asks": with approvals off,
 * tools the agent writes for itself still ask, and so do MCP server tools
 * while MCP protection is on (Settings → Agent).
 */
export function approvalModes(mcpProtection: boolean): ModeCopy[] {
  return [
    { mode: 'mutating', label: 'Edits and commands', description: 'Recommended. Reading is free; changing things asks first.' },
    { mode: 'all', label: 'Every tool', description: 'Even reads and searches ask.' },
    {
      mode: 'off',
      label: 'Unattended',
      description: mcpProtection
        ? 'For runs nobody is watching. MCP tools and tools the agent writes still ask.'
        : 'For runs nobody is watching. Tools the agent writes still ask.'
    }
  ]
}

/** Arrow keys move the choice, as in any radio group. */
function moveChoice(e: KeyboardEvent<HTMLButtonElement>, modes: readonly ToolApprovalMode[], current: ToolApprovalMode, onChange: (mode: ToolApprovalMode) => void): void {
  const i = modes.indexOf(current)
  let next = -1
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % modes.length
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + modes.length) % modes.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = modes.length - 1
  if (next < 0) return
  e.preventDefault()
  onChange(modes[next]!)
  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
}

/** What needs your OK: one radio per approval mode, the chosen row filled. */
export function ApprovalModeChoice({
  value,
  onChange,
  mcpProtection = true,
  label = 'What needs your OK'
}: {
  value: ToolApprovalMode
  onChange: (mode: ToolApprovalMode) => void
  mcpProtection?: boolean
  label?: string
}) {
  const modes = approvalModes(mcpProtection)
  const ids = modes.map((m) => m.mode)
  return (
    <div role="radiogroup" aria-label={label} className="-mx-2 space-y-px">
      {modes.map((m) => {
        const on = m.mode === value
        return (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(m.mode)}
            onKeyDown={(e) => moveChoice(e, ids, value, onChange)}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left vy-transition focus-visible:vy-focus-ring',
              on ? 'bg-surface' : 'hover:bg-surface'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-[3px] inline-grid size-3.5 shrink-0 place-items-center rounded-full border',
                on ? 'border-accent' : 'border-border-strong'
              )}
            >
              {on ? <span className="size-1.5 rounded-full bg-accent" /> : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-fg">{m.label}</span>
              <span className="block text-xs text-muted">{m.description}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
