import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import type {
  MarketplaceOverrides,
  SlashCommandDescriptor,
  SlashCommandResolveResult,
  SlashCommandsCreateRuleResult,
  SlashCommandsCreateSkillResult
} from '../../../shared/ipc'
import { normalizeTrigger, triggerKey } from '../../../shared/slashCommands'
import {
  findWorkspaceSettingsOverride,
  getWorkspaces
} from '../../workspace/workspaces'
import { BUILTIN_COMMANDS, buildHelpMessage, resolveBuiltin } from './builtins'
import { listSkillCommands, resolveSkillCommand } from './skills'
import { listWorkspaceCommands, resolveWorkspaceCommand } from './workspaceCommands'
import { listRuleCommands, resolveRuleCommand } from './ruleCommands'
import { listMcpCommands, resolveMcpCommand } from './mcp'
import { listSlashMcpServers } from './mcpServers'
import { runHarnessReviewWithSettings } from '../harnessReviewRun'
import { createLocalSkill } from '../skills/local'
import { clearRulesCache } from '../context/rules'
import { notifySkillsChanged } from '../skills/notify'
import {
  LIST_TTL_MS,
  clearSlashListInflight,
  getSlashListCacheEntry,
  getSlashListInflight,
  listCacheKey,
  setSlashListCacheEntry,
  setSlashListInflight,
  type SlashList
} from './listCache'

export { invalidateSlashCommandsCache } from './listCache'

function marketplaceOverridesFor(
  workspacePath: string | null | undefined
): MarketplaceOverrides | null {
  if (!workspacePath) return null
  const override = findWorkspaceSettingsOverride(getWorkspaces(), workspacePath)
  return override?.marketplaceOverrides ?? null
}

/**
 * Deduplicate by trigger: builtins win, then ready skills/workspace/rules/mcp.
 * Later sources only fill unused triggers (or replace weaker availability).
 */
function mergeByTrigger(groups: SlashCommandDescriptor[][]): SlashCommandDescriptor[] {
  const byKey = new Map<string, SlashCommandDescriptor>()
  const rank = (a: SlashCommandDescriptor['availability']): number => {
    switch (a) {
      case 'ready':
        return 4
      case 'disabled':
        return 3
      case 'disconnected':
      case 'needs_auth':
        return 2
      case 'not_installed':
        return 1
      default: {
        const _exhaustive: never = a
        return _exhaustive
      }
    }
  }
  const kindRank = (k: SlashCommandDescriptor['kind']): number => {
    switch (k) {
      case 'builtin':
        return 5
      case 'workspace':
        return 4
      case 'skill':
        return 3
      case 'rule':
        return 2
      case 'mcp':
        return 1
      default: {
        const _exhaustive: never = k
        return _exhaustive
      }
    }
  }

  for (const group of groups) {
    for (const cmd of group) {
      const key = triggerKey(cmd.trigger)
      if (!key) continue
      const prev = byKey.get(key)
      if (!prev) {
        byKey.set(key, cmd)
        continue
      }
      if (rank(cmd.availability) > rank(prev.availability)) {
        byKey.set(key, cmd)
        continue
      }
      if (
        rank(cmd.availability) === rank(prev.availability) &&
        kindRank(cmd.kind) > kindRank(prev.kind)
      ) {
        byKey.set(key, cmd)
      }
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group)
    return a.trigger.localeCompare(b.trigger)
  })
}

export async function listSlashCommands(
  workspacePath?: string | null
): Promise<SlashCommandDescriptor[]> {
  return (await listSlashMenu(workspacePath)).commands
}

/** The commands, and the MCP servers their tools belong to. */
export async function listSlashMenu(workspacePath?: string | null): Promise<SlashList> {
  const key = listCacheKey(workspacePath)
  const hit = getSlashListCacheEntry(key)
  if (hit && Date.now() <= hit.expiresAt) {
    return { commands: hit.commands, mcpServers: hit.mcpServers }
  }

  const pending = getSlashListInflight(key)
  if (pending) return pending

  const run = (async () => {
    const overrides = marketplaceOverridesFor(workspacePath)
    const [skills, workspace, rules] = await Promise.all([
      listSkillCommands(overrides, workspacePath ?? null),
      listWorkspaceCommands(workspacePath ?? null),
      listRuleCommands(workspacePath ?? null)
    ])
    const mcp = listMcpCommands(overrides, workspacePath ?? null)
    const commands = mergeByTrigger([BUILTIN_COMMANDS, workspace, skills, rules, mcp])
    const mcpServers = listSlashMcpServers(commands, overrides)
    setSlashListCacheEntry(key, { commands, mcpServers, expiresAt: Date.now() + LIST_TTL_MS })
    return { commands, mcpServers }
  })()

  setSlashListInflight(key, run)
  try {
    return await run
  } finally {
    clearSlashListInflight(key, run)
  }
}

export async function resolveSlashCommand(
  id: string,
  args: {
    workspacePath?: string | null
    trailingText?: string
  }
): Promise<SlashCommandResolveResult> {
  const trailingText = args.trailingText ?? ''
  const workspacePath = args.workspacePath ?? null
  const overrides = marketplaceOverridesFor(workspacePath)

  const builtin = resolveBuiltin(
    id,
    trailingText,
    buildHelpMessage(await listSlashCommands(workspacePath))
  )
  if (builtin) return builtin

  if (id === 'builtin:harness-review') {
    if (!workspacePath) {
      return {
        action: 'send',
        message: 'Open a workspace before running `/harness-review`.'
      }
    }
    try {
      const result = await runHarnessReviewWithSettings(workspacePath)
      return { action: 'open_file', path: result.proposalPath }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { action: 'send', message: `Harness review failed: ${msg}` }
    }
  }

  if (id.startsWith('skill:')) {
    const result = resolveSkillCommand(id, trailingText, overrides, workspacePath)
    if (result) return result
  }

  if (id.startsWith('workspace:')) {
    const result = await resolveWorkspaceCommand(id, workspacePath, trailingText)
    if (result) return result
  }

  if (id.startsWith('rule:')) {
    const result = await resolveRuleCommand(id, workspacePath)
    if (result) return result
  }

  if (id.startsWith('mcp:') || id.startsWith('mcp-server:')) {
    const result = resolveMcpCommand(id, trailingText, overrides, workspacePath)
    if (result) return result
  }

  return { action: 'send', message: `Unknown slash command: ${id}` }
}

/** Find a command by typed trigger among the listed set. */
export async function findSlashCommandByTrigger(
  trigger: string,
  workspacePath?: string | null
): Promise<SlashCommandDescriptor | null> {
  const key = triggerKey(trigger)
  if (!key) return null
  const commands = await listSlashCommands(workspacePath)
  return commands.find((c) => triggerKey(c.trigger) === key) ?? null
}

export async function createWorkspaceRule(
  workspacePath: string,
  title?: string
): Promise<SlashCommandsCreateRuleResult> {
  const rulesDir = join(workspacePath, '.vyotiq', 'rules')
  mkdirSync(rulesDir, { recursive: true })

  const base =
    normalizeTrigger(title || '') ||
    `rule-${new Date().toISOString().slice(0, 10)}`
  let slug = base.replace(/[^a-z0-9-]/g, '-') || 'new-rule'
  let fileName = `${slug}.md`
  let absolute = join(rulesDir, fileName)
  let n = 2
  while (existsSync(absolute)) {
    fileName = `${slug}-${n}.md`
    absolute = join(rulesDir, fileName)
    n += 1
  }

  const displayTitle = (title ?? '').trim() || slug
  const body = [
    '---',
    'alwaysApply: true',
    `description: ${displayTitle}`,
    '---',
    '',
    `# ${displayTitle}`,
    '',
    'Describe how the agent should behave in this workspace.',
    ''
  ].join('\n')
  writeFileSync(absolute, body, 'utf8')
  clearRulesCache(workspacePath)
  notifySkillsChanged(workspacePath)

  return {
    path: absolute,
    relativePath: `.vyotiq/rules/${fileName}`
  }
}

export async function createWorkspaceSkill(
  workspacePath: string | null | undefined,
  title?: string,
  scope?: 'project' | 'personal'
): Promise<SlashCommandsCreateSkillResult> {
  const created = createLocalSkill({
    workspacePath: workspacePath ?? null,
    title,
    scope
  })
  notifySkillsChanged(workspacePath ?? null)

  return {
    path: created.path,
    relativePath: created.relativePath,
    name: created.name,
    source: created.source
  }
}

export async function openSlashFile(path: string): Promise<void> {
  await shell.openPath(path)
}
