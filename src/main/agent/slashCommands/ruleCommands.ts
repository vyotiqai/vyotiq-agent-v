import { basename, join } from 'path'
import type { SlashCommandDescriptor, SlashCommandResolveResult } from '../../../shared/ipc'
import { normalizeTrigger } from '../../../shared/slashCommands'
import { readWorkspaceRules } from '../context/rules'

/** List existing workspace rules as open-file slash commands. */
export async function listRuleCommands(
  workspacePath: string | null
): Promise<SlashCommandDescriptor[]> {
  if (!workspacePath) return []
  const files = await readWorkspaceRules(workspacePath)
  const out: SlashCommandDescriptor[] = []
  const seen = new Set<string>()

  for (const file of files) {
    // Skip root AGENTS.md / CLAUDE.md — not useful as /agents open shortcuts vs create-rule.
    if (file.path === 'AGENTS.md' || file.path === 'CLAUDE.md') continue
    const stem = basename(file.path).replace(/\.(mdc?|md)$/i, '')
    const trigger = normalizeTrigger(stem)
    if (!trigger || seen.has(trigger)) continue
    seen.add(trigger)
    out.push({
      id: `rule:${file.path}`,
      trigger,
      label: stem,
      description: `Open rule ${file.path}`,
      kind: 'rule',
      group: 'Rules',
      availability: 'ready'
    })
  }
  return out
}

export async function resolveRuleCommand(
  id: string,
  workspacePath: string | null
): Promise<SlashCommandResolveResult | null> {
  if (!id.startsWith('rule:') || !workspacePath) return null
  const rel = id.slice('rule:'.length)
  const absolute = join(workspacePath, ...rel.split('/'))
  return { action: 'open_file', path: absolute }
}
