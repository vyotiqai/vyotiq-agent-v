import type {
  BuiltinClientAction,
  SlashCommandDescriptor,
  SlashCommandResolveResult
} from '@shared/ipc'

export type SlashClientHandlers = {
  /** Task-boundary reset — start a fresh chat (Claude Code `/clear` practice). */
  onClear?: () => void | boolean | Promise<void | boolean>
  onCompact?: (focus?: string) => void | boolean | Promise<void | boolean>
  onUndoWrites?: () => void | boolean | Promise<void | boolean>
  onSetAgentMode?: (mode: 'ask' | 'plan' | 'agent') => void | boolean | Promise<void | boolean>
  onOpenMarketplace?: (mcpServerId?: string) => void
  onOpenSettings?: (section?: 'voice' | 'providers' | 'agent') => void
  onCreateRule?: (title?: string) => void | boolean | Promise<void | boolean>
  onCreateSkill?: (title?: string) => void | boolean | Promise<void | boolean>
  onHarnessApply?: (proposalPath?: string) => void | boolean | Promise<void | boolean>
  onGoalPause?: () => void | boolean | Promise<void | boolean>
  onGoalResume?: () => void | boolean | Promise<void | boolean>
  onGoalComplete?: () => void | boolean | Promise<void | boolean>
  onGoalUsage?: () => void | boolean | Promise<void | boolean>
  onLoopSet?: (trailing?: string) => void | boolean | Promise<void | boolean>
  onLoopStop?: () => void | boolean | Promise<void | boolean>
  onLoopStatus?: () => void | boolean | Promise<void | boolean>
  onMarketplaceAction?: (
    packageId: string,
    intent: 'install' | 'enable'
  ) => void | Promise<unknown>
  onOpenFile?: (path: string) => void | Promise<unknown>
  onNotice?: (message: string) => void
}

export async function executeSlashResolveResult(
  result: SlashCommandResolveResult,
  handlers: SlashClientHandlers
): Promise<'sent' | 'handled' | 'pending' | 'failed'> {
  switch (result.action) {
    case 'send':
      return 'sent'
    case 'client': {
      const ok = await runClientAction(result.clientAction, handlers, {
        trailingText: result.trailingText,
        mcpServerId: result.mcpServerId
      })
      return ok ? 'handled' : 'failed'
    }
    case 'marketplace':
      await handlers.onMarketplaceAction?.(result.packageId, result.intent)
      return 'pending'
    case 'open_file':
      await handlers.onOpenFile?.(result.path)
      return 'handled'
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

async function runClientAction(
  action: BuiltinClientAction,
  handlers: SlashClientHandlers,
  opts: { trailingText?: string; mcpServerId?: string }
): Promise<boolean> {
  switch (action) {
    case 'clear': {
      const r = await handlers.onClear?.()
      return r !== false
    }
    case 'compact': {
      if (!handlers.onCompact) return false
      const focus = opts.trailingText?.trim()
      const r = await handlers.onCompact(focus || undefined)
      return r !== false
    }
    case 'undo_writes': {
      const r = await handlers.onUndoWrites?.()
      return r !== false
    }
    case 'set_mode_ask': {
      const r = await handlers.onSetAgentMode?.('ask')
      return r !== false
    }
    case 'set_mode_plan': {
      const r = await handlers.onSetAgentMode?.('plan')
      return r !== false
    }
    case 'set_mode_agent': {
      const r = await handlers.onSetAgentMode?.('agent')
      return r !== false
    }
    case 'open_marketplace':
      handlers.onOpenMarketplace?.(opts.mcpServerId)
      return true
    case 'open_settings':
      handlers.onOpenSettings?.()
      return true
    case 'create_rule': {
      const r = await handlers.onCreateRule?.(opts.trailingText)
      return r !== false
    }
    case 'create_skill': {
      const r = await handlers.onCreateSkill?.(opts.trailingText)
      return r !== false
    }
    case 'harness_apply': {
      const r = await handlers.onHarnessApply?.(opts.trailingText)
      return r !== false
    }
    case 'goal_pause': {
      const r = await handlers.onGoalPause?.()
      return r !== false
    }
    case 'goal_resume': {
      const r = await handlers.onGoalResume?.()
      return r !== false
    }
    case 'goal_complete': {
      const r = await handlers.onGoalComplete?.()
      return r !== false
    }
    case 'goal_usage': {
      const r = await handlers.onGoalUsage?.()
      return r !== false
    }
    case 'loop_set': {
      const r = await handlers.onLoopSet?.(opts.trailingText)
      return r !== false
    }
    case 'loop_stop': {
      const r = await handlers.onLoopStop?.()
      return r !== false
    }
    case 'loop_status': {
      const r = await handlers.onLoopStatus?.()
      return r !== false
    }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

export function availabilityCtaLabel(
  availability: SlashCommandDescriptor['availability']
): string | null {
  switch (availability) {
    case 'ready':
      return null
    case 'disabled':
      return 'Enable'
    case 'not_installed':
      return 'Install'
    case 'needs_auth':
    case 'disconnected':
      return 'Connect'
    default: {
      const _exhaustive: never = availability
      return _exhaustive
    }
  }
}
