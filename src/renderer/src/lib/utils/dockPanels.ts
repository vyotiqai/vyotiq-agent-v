import type { IconName } from '@renderer/lib/icons'
import type { ChatRightPanelId } from './layout'

export type DockPanelDef = {
  id: ChatRightPanelId
  icon: IconName
  /** Short label for dock tabs / add menu. */
  label: string
  showLabel: string
  hideLabel: string
}

/** Single source of truth for side rail + dock tab chrome. */
export const DOCK_PANELS: readonly DockPanelDef[] = [
  {
    id: 'files',
    icon: 'folder',
    label: 'Files',
    showLabel: 'Show files panel',
    hideLabel: 'Hide files panel'
  },
  {
    id: 'browser',
    icon: 'globe',
    label: 'Browser',
    showLabel: 'Show browser panel',
    hideLabel: 'Hide browser panel'
  },
  {
    id: 'terminal',
    icon: 'terminal',
    label: 'Terminal',
    showLabel: 'Show terminal panel',
    hideLabel: 'Hide terminal panel'
  },
  {
    id: 'changes',
    icon: 'branch',
    label: 'Changes',
    showLabel: 'Show changes panel',
    hideLabel: 'Hide changes panel'
  },
  {
    id: 'pr',
    icon: 'pullRequest',
    label: 'Pull Request',
    showLabel: 'Show pull request panel',
    hideLabel: 'Hide pull request panel'
  },
  {
    id: 'plan',
    icon: 'doc',
    label: 'Plan',
    showLabel: 'Show plan panel',
    hideLabel: 'Hide plan panel'
  }
] as const

const BY_ID = new Map(DOCK_PANELS.map((p) => [p.id, p]))

export function dockPanelDef(id: ChatRightPanelId): DockPanelDef {
  const found = BY_ID.get(id)
  if (!found) {
    return {
      id,
      icon: 'branch',
      label: id,
      showLabel: `Show ${id} panel`,
      hideLabel: `Hide ${id} panel`
    }
  }
  return found
}
