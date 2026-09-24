import type { SlashCommandDescriptor, SlashCommandResolveResult } from '../../../shared/ipc'
import { formatGoalInvocation, loopUsageMessage, parseLoopCommand } from '../../../shared/goalRuntime'

export const BUILTIN_COMMANDS: SlashCommandDescriptor[] = [
  {
    id: 'builtin:clear',
    trigger: 'clear',
    label: 'Clear / new chat',
    description: 'Start a new task. Prefer this over carrying stale history into unrelated work',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:compact',
    trigger: 'compact',
    label: 'Compact context',
    description: 'Summarise older steps to free context. Text after /compact says what to keep',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:marketplace',
    trigger: 'marketplace',
    label: 'Open Extensions',
    description: 'Browse and manage MCP servers, skills, rules and packages',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:settings',
    trigger: 'settings',
    label: 'Open Settings',
    description: 'Open application settings',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:create-rule',
    trigger: 'create-rule',
    label: 'Create rule',
    description: 'Create a new workspace rule under .vyotiq/rules/',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:create-skill',
    trigger: 'create-skill',
    label: 'Create skill',
    description: 'Create a new skill under .vyotiq/skills/ (or /create-skill personal)',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:help',
    trigger: 'help',
    label: 'Slash commands',
    description: 'List available slash commands',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:undo',
    trigger: 'undo',
    label: 'Undo agent writes',
    description: 'Restore files from the last agent write checkpoint for this run',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:ask',
    trigger: 'ask',
    label: 'Ask mode',
    description: 'Switch to Ask mode (read-only tools)',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:plan',
    trigger: 'plan',
    label: 'Plan mode',
    description: 'Switch to Plan mode (explore + plan artifacts)',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:agent',
    trigger: 'agent',
    label: 'Agent mode',
    description: 'Switch to Agent mode (full tools)',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:harness-review',
    trigger: 'harness-review',
    label: 'Harness review',
    description: 'Mine recent run receipts into a resources/harness/proposals/ draft',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:harness-apply',
    trigger: 'harness-apply',
    label: 'Apply harness proposal',
    description: 'Confirm-apply latest (or named) proposal to resources/harness/default.md',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:goal',
    trigger: 'goal',
    label: 'Set goal',
    description: 'Keep working toward an objective. /goal pause, resume or complete it',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:loop',
    trigger: 'loop',
    label: 'Arm loop',
    description: 'Repeat an instruction on an interval. /loop 30s check CI; /loop stop disarms it',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  }
]

export function resolveBuiltin(
  id: string,
  trailingText: string,
  helpMessage: string
): SlashCommandResolveResult | null {
  switch (id) {
    case 'builtin:clear':
      return { action: 'client', clientAction: 'clear' }
    case 'builtin:compact':
      return {
        action: 'client',
        clientAction: 'compact',
        ...(trailingText.trim() ? { trailingText: trailingText.trim() } : {})
      }
    case 'builtin:marketplace':
      return { action: 'client', clientAction: 'open_marketplace' }
    case 'builtin:settings':
      return { action: 'client', clientAction: 'open_settings' }
    case 'builtin:create-rule':
      return {
        action: 'client',
        clientAction: 'create_rule',
        ...(trailingText.trim() ? { trailingText: trailingText.trim() } : {})
      }
    case 'builtin:create-skill':
      return {
        action: 'client',
        clientAction: 'create_skill',
        ...(trailingText.trim() ? { trailingText: trailingText.trim() } : {})
      }
    case 'builtin:help':
      return { action: 'send', message: helpMessage }
    case 'builtin:undo':
      return { action: 'client', clientAction: 'undo_writes' }
    case 'builtin:ask':
      return { action: 'client', clientAction: 'set_mode_ask' }
    case 'builtin:plan':
      return { action: 'client', clientAction: 'set_mode_plan' }
    case 'builtin:agent':
      return { action: 'client', clientAction: 'set_mode_agent' }
    case 'builtin:harness-review':
      // Resolved in resolveSlashCommand (needs workspace + main-process mining).
      return null
    case 'builtin:harness-apply':
      return {
        action: 'client',
        clientAction: 'harness_apply',
        ...(trailingText.trim() ? { trailingText: trailingText.trim() } : {})
      }
    case 'builtin:goal': {
      const text = trailingText.trim()
      if (!text) return { action: 'client', clientAction: 'goal_usage' }
      if (/^pause\b/i.test(text)) return { action: 'client', clientAction: 'goal_pause' }
      if (/^resume\b/i.test(text)) return { action: 'client', clientAction: 'goal_resume' }
      if (/^complete\b/i.test(text)) return { action: 'client', clientAction: 'goal_complete' }
      return { action: 'send', message: formatGoalInvocation(text) }
    }
    case 'builtin:loop': {
      const parsed = parseLoopCommand(trailingText)
      if (parsed.kind === 'stop') return { action: 'client', clientAction: 'loop_stop' }
      if (parsed.kind === 'status') return { action: 'client', clientAction: 'loop_status' }
      if (parsed.kind === 'usage') return { action: 'send', message: loopUsageMessage() }
      if (parsed.kind === 'error') return { action: 'send', message: parsed.message }
      return {
        action: 'client',
        clientAction: 'loop_set',
        trailingText: trailingText.trim()
      }
    }
    default:
      return null
  }
}

export function buildHelpMessage(commands: SlashCommandDescriptor[]): string {
  const lines = [
    'Available slash commands:',
    '',
    ...commands
      .filter((c) => c.availability === 'ready')
      .slice(0, 40)
      .map((c) => `- \`/${c.trigger}\` — ${c.description || c.label}`),
    '',
    'Type `/` in the composer to search all commands.'
  ]
  return lines.join('\n')
}
