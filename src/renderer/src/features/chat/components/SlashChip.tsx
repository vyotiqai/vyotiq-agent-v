import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { SlashCommandKind } from '@shared/ipc'

const KIND_TITLE: Record<SlashCommandKind, string> = {
  skill: 'Skill',
  mcp: 'MCP',
  builtin: 'Command',
  workspace: 'Command',
  rule: 'Rule'
}

const KIND_ICON: Record<SlashCommandKind, IconName> = {
  skill: 'sparkles',
  mcp: 'plug',
  builtin: 'gear',
  workspace: 'doc',
  rule: 'file'
}

/** Compact slash/mention pill for timeline / read-only surfaces (no chrome). */
export function SlashChip({
  name,
  kind = 'skill',
  className
}: {
  name: string
  kind?: SlashCommandKind
  className?: string
}) {
  const iconName = KIND_ICON[kind]
  return (
    <span
      className={cn(
        'inline-flex max-w-[12rem] items-center gap-1 px-0.5 text-sm leading-none text-accent',
        className
      )}
      title={`${KIND_TITLE[kind]}: ${name}`}
    >
      <Icon name={iconName} size={12} className="shrink-0 opacity-80" />
      <span className="truncate">{name}</span>
    </span>
  )
}
