import type { WorkspaceAgentContextResult } from '@shared/ipc'

type Rules = WorkspaceAgentContextResult['rules']

/** The workspace's root instruction files that reach the prompt, in precedence order. */
export function ruleRootFiles(rules: Rules | null | undefined): string[] {
  if (!rules) return []
  return [rules.agentsMd ? 'AGENTS.md' : null, rules.claudeMd ? 'CLAUDE.md' : null, rules.cursorrules ? '.cursorrules' : null].filter(
    (n): n is string => Boolean(n)
  )
}

/** "1 rule file" / "3 rule files" — what `.cursor/rules` and `.vyotiq/rules` add. */
export function ruleFileCountLabel(n: number): string {
  return `${n} rule ${n === 1 ? 'file' : 'files'}`
}

/** "AGENTS.md and 2 rule files", "CLAUDE.md", "3 rule files", or "No rules yet". */
export function ruleSummary(rules: Rules): string {
  const parts = [...ruleRootFiles(rules), rules.ruleFileCount > 0 ? ruleFileCountLabel(rules.ruleFileCount) : null].filter(
    (n): n is string => Boolean(n)
  )
  if (parts.length === 0) return 'No rules yet'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
