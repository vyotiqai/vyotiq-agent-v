import { useState } from 'react'
import type { ToolApprovalMode, ToolApprovalSettings } from '@shared/ipc'
import { ActionMenu, cn, type ActionMenuItem } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { CONTROL_HOVER, SELECTED } from '@renderer/lib/utils/layout'

/** What the control row says: short, because it sits beside the model. */
export const APPROVAL_LABEL: Record<ToolApprovalMode, string> = {
  off: 'Doesn’t ask',
  mutating: 'Asks before edits',
  all: 'Asks every time'
}

const APPROVAL_NOTE: Record<ToolApprovalMode, string> = {
  off: 'Runs every tool without asking',
  mutating: 'Reads freely; you approve edits and commands',
  all: 'You approve every tool it uses'
}

const MODES: ToolApprovalMode[] = ['off', 'mutating', 'all']

/** The default every new install starts from; anything else reads in ink. */
const DEFAULT_MODE: ToolApprovalMode = 'mutating'

/**
 * How tools ask before they run, in the control row beside the model: the
 * one run setting that used to be a sentence under the box, changed in place.
 * It writes where the model's effort writes (this workspace's override when it
 * has one, else every workspace); Agent settings… is the way to the rest.
 */
export function PermissionsControl({
  approval,
  onChange,
  onOpenSettings,
  placement = 'up',
  disabled = false
}: {
  approval: ToolApprovalSettings
  onChange: (next: ToolApprovalSettings) => void
  onOpenSettings?: () => void
  placement?: 'up' | 'down'
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const mode = approval.mode
  const mcpAsks = approval.mcpProtection !== false
  const items: ActionMenuItem[] = MODES.map((m, i) => ({
    id: `mode-${m}`,
    label: APPROVAL_LABEL[m],
    detail: APPROVAL_NOTE[m],
    checked: m === mode,
    ...(i === 0 ? { heading: 'Before it uses a tool' } : {}),
    onSelect: () => onChange({ ...approval, mode: m })
  }))
  items.push({
    id: 'mcp',
    label: 'MCP tools ask first',
    checked: mode === 'all' || mcpAsks,
    separatorBefore: true,
    keepOpen: true,
    disabled: mode === 'all',
    disabledReason: 'Every tool asks already',
    onSelect: () => onChange({ ...approval, mcpProtection: !mcpAsks })
  })
  if (onOpenSettings) {
    items.push({ id: 'settings', label: 'Agent settings…', icon: 'gear', separatorBefore: true, onSelect: onOpenSettings })
  }
  const changed = mode !== DEFAULT_MODE
  return (
    <ActionMenu
      open={open}
      onOpenChange={setOpen}
      placement={placement}
      aria-label="Permissions"
      items={items}
      trigger={(t) => (
        <button
          ref={t.ref}
          type="button"
          disabled={disabled}
          aria-label={`Permissions: ${APPROVAL_LABEL[mode]}`}
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
          data-composer-permissions
          className={cn(
            'inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs vy-transition focus-visible:vy-focus-ring disabled:vy-disabled-state',
            open ? SELECTED : changed ? cn('text-fg', CONTROL_HOVER) : cn('text-muted hover:text-fg', CONTROL_HOVER)
          )}
        >
          <Icon name="shield" size={13} className="shrink-0" />
          <span className="truncate @max-[560px]:sr-only">{APPROVAL_LABEL[mode]}</span>
        </button>
      )}
    />
  )
}
