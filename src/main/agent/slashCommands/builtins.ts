import type { SlashCommandDescriptor, SlashCommandResolveResult } from '../../../shared/ipc'
import { formatGoalInvocation, loopUsageMessage, parseLoopCommand } from '../../../shared/goalRuntime'
import { initMessage, reviewMessage } from '../../../shared/utils/agentPrompts'
export { parseReviewScope } from '../../../shared/utils/agentPrompts'

export const BUILTIN_COMMANDS: SlashCommandDescriptor[] = [
  {
    id: 'builtin:clear',
    trigger: 'clear',
    label: 'Clear / new task',
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
    id: 'builtin:agent',
    trigger: 'agent',
    label: 'Agent mode',
    description: 'Switch to Agent mode (plan, edit, terminal, MCP)',
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
  },
  {
    id: 'builtin:init',
    trigger: 'init',
    label: 'Write AGENTS.md',
    description: 'Draft AGENTS.md from this repo: build, test and lint commands, layout, conventions. Text after /init says what to stress',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:review',
    trigger: 'review',
    label: 'Review changes',
    description: 'Review uncommitted changes for bugs, regressions and missing tests. /review branch, or /review task for this task’s changes',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  },
  {
    id: 'builtin:add-dir',
    trigger: 'add-dir',
    label: 'Add folder',
    description: 'Let this task also work in another folder. /add-dir <absolute path>, or no path to pick one',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  }
]

/** Built-ins that step aside for a workspace command or skill with the same trigger. */
export const YIELDING_BUILTINS: ReadonlySet<string> = new Set(['init', 'review'])

export function resolveBuiltin(
  id: string,
  trailingText: string
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
      // The slash menu is the list: reopening it costs nothing, where sending
      // a written list would start a paid run to echo it back.
      return { action: 'client', clientAction: 'help' }
    case 'builtin:undo':
      return { action: 'client', clientAction: 'undo_writes' }
    case 'builtin:ask':
      return { action: 'client', clientAction: 'set_mode_ask' }
    case 'builtin:agent':
      return { action: 'client', clientAction: 'set_mode_agent' }
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
      // Usage and parse errors are for the person typing, never the model.
      if (parsed.kind === 'usage') return { action: 'notice', message: loopUsageMessage() }
      if (parsed.kind === 'error') return { action: 'notice', message: parsed.message }
      return {
        action: 'client',
        clientAction: 'loop_set',
        trailingText: trailingText.trim()
      }
    }
    case 'builtin:init':
      return { action: 'send', message: initMessage(trailingText.trim()), mode: 'agent' }
    case 'builtin:review':
      return { action: 'send', message: reviewMessage(trailingText.trim()) }
    case 'builtin:add-dir': {
      // Quotes are how a path with spaces is usually pasted.
      const path = trailingText.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
      return { action: 'client', clientAction: 'add_dir', ...(path ? { trailingText: path } : {}) }
    }
    default:
      return null
  }
}
