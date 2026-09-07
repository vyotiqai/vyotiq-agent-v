import { readdir, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { basename, join } from 'path'
import { readGitStatusCached } from '../../git/gitStatusCache'
import type { CodeIndexModelPhase, WorkspaceAgentContextResult } from '../../../shared/ipc'

/** Card-facing code-index state (workspace:agentContext payload). */
export type CodeIndexCardState = 'ready' | 'building' | 'degraded' | 'off'

/**
 * Map the live code-index runtime phase to the context-card state.
 * `idle` is the runtime's own neutral phase (initial state, and it reports
 * `idle` when the index is disabled — see workspaceIndex.ts) so it maps to the
 * documented neutral value 'off'. `fallback_hash` / `error` are degraded, the
 * in-flight phases (`downloading` / `loading` / `indexing`) are building.
 * Never invents status: unknown input falls through to 'off'.
 */
export function mapCodeIndexState(
  phase: CodeIndexModelPhase,
  enabled: boolean
): CodeIndexCardState {
  if (!enabled) return 'off'
  switch (phase) {
    case 'ready':
      return 'ready'
    case 'downloading':
    case 'loading':
    case 'indexing':
      return 'building'
    case 'fallback_hash':
    case 'error':
      return 'degraded'
    case 'idle':
      return 'off'
  }
}

async function existsAsync(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Mirrors the rules service walker (context/rules.ts): `.md`, depth ≤ 3, cap 24. */
const MAX_DIR_DEPTH = 3
const MAX_RULE_FILES = 24

async function countRuleFiles(dirPath: string, depth: number): Promise<number> {
  if (depth > MAX_DIR_DEPTH) return 0
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return 0
  }
  let count = 0
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (count >= MAX_RULE_FILES) break
    if (entry.isDirectory()) {
      count += await countRuleFiles(join(dirPath, entry.name), depth + 1)
      continue
    }
    if (entry.name.toLowerCase().endsWith('.md')) count++
  }
  return count
}

async function countMarkdownFiles(dirPath: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countMarkdownFiles(join(dirPath, entry.name))
      continue
    }
    if (entry.name.toLowerCase().endsWith('.md')) count++
  }
  return count
}

/** Current branch via the shared cached git status; null when not a repo / unnamed. */
async function currentBranch(workspacePath: string): Promise<string | null> {
  try {
    const result = await readGitStatusCached(workspacePath)
    return result.kind === 'ok' ? (result.status.branch ?? null) : null
  } catch {
    return null
  }
}

/**
 * Build the read-only "what the agent knows" summary for a workspace.
 * All fs access is async; every sub-signal degrades to its neutral value
 * (branch null, counts 0, code-index state 'off') rather than failing.
 */
export async function buildWorkspaceAgentContext(
  workspacePath: string,
  codeIndex: { enabled: boolean; phase: CodeIndexModelPhase }
): Promise<WorkspaceAgentContextResult> {
  const [agentsMd, cursorrules, vyotiqRulesCount, memoryNotes, branch] = await Promise.all([
    existsAsync(join(workspacePath, 'AGENTS.md')),
    existsAsync(join(workspacePath, '.cursorrules')),
    countRuleFiles(join(workspacePath, '.vyotiq', 'rules'), 0),
    countMarkdownFiles(join(workspacePath, '.vyotiq', 'memory')),
    currentBranch(workspacePath)
  ])
  return {
    workspaceName: basename(workspacePath),
    branch,
    rules: { agentsMd, cursorrules, vyotiqRulesCount },
    memoryNotes,
    codeIndex: { state: mapCodeIndexState(codeIndex.phase, codeIndex.enabled) }
  }
}
