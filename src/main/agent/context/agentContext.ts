import { readdir, stat } from 'fs/promises'
import { existsSync, type Dirent } from 'fs'
import { basename, join } from 'path'
import { readGitStatusCached } from '../../git/gitStatusCache'
import { countWorkspaceRuleSources } from './rules'
import { codeindexDbPath } from '../indexStoragePaths'
import { getOrOpenCodeIndexStore } from '../codeindex/storeCache'
import { workspacePathsEqual } from '../../../shared/workspacePathMatch'
import type { CodeIndexModelPhase, WorkspaceAgentContextResult } from '../../../shared/ipc'

/** Card-facing code-index state (workspace:agentContext payload). */
export type CodeIndexCardState = 'ready' | 'building' | 'degraded' | 'off'

/**
 * Map the live code-index runtime phase to the context-card state.
 * `idle` is the runtime's own neutral phase (initial state, and it reports
 * `idle` when the index is disabled — see workspaceIndex.ts) so it maps to the
 * documented neutral value 'off'. `error` is degraded, the in-flight phase
 * (`syncing`) is building. Never invents status: unknown input falls through
 * to 'off'.
 */
export function mapCodeIndexState(
  phase: CodeIndexModelPhase,
  enabled: boolean
): CodeIndexCardState {
  if (!enabled) return 'off'
  switch (phase) {
    case 'ready':
      return 'ready'
    case 'syncing':
      return 'building'
    case 'error':
      return 'degraded'
    case 'idle':
      return 'off'
  }
}

/** How many note names the summary carries. */
const NOTE_NAMES_SHOWN = 3

/**
 * The notes in `.vyotiq/memory/notes`, newest first. `index.md` and
 * `state.md` are the memory's own files, not notes — `memory_write` keeps
 * every note in `notes/<name>.md`.
 */
async function readMemoryNotes(workspacePath: string): Promise<{ count: number; names: string[] }> {
  const dir = join(workspacePath, '.vyotiq', 'memory', 'notes')
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return { count: 0, names: [] }
  }
  const notes = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
  const stamped = await Promise.all(
    notes.map(async (entry) => {
      const name = entry.name.slice(0, -'.md'.length)
      try {
        return { name, at: (await stat(join(dir, entry.name))).mtimeMs }
      } catch {
        return { name, at: 0 }
      }
    })
  )
  stamped.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
  return { count: notes.length, names: stamped.slice(0, NOTE_NAMES_SHOWN).map((note) => note.name) }
}

type IndexFacts = { files: number; indexedAt: string | null }

/** This workspace's own index, read only when one exists — never created here. */
function readIndexFacts(workspacePath: string): IndexFacts | null {
  try {
    if (!existsSync(codeindexDbPath(workspacePath))) return null
    const status = getOrOpenCodeIndexStore(workspacePath).getStatus()
    return { files: status.fileCount, indexedAt: status.lastIndexedAt }
  } catch {
    return null
  }
}

/**
 * One index status serves every workspace, so its phase speaks only for the
 * workspace it names. Any other workspace answers from its own index: built
 * before is ready, never built is off.
 */
export function codeIndexStateFor(
  workspacePath: string,
  codeIndex: { enabled: boolean; phase: CodeIndexModelPhase; statusWorkspace?: string },
  index: IndexFacts | null
): CodeIndexCardState {
  if (!codeIndex.enabled) return 'off'
  if (codeIndex.statusWorkspace && workspacePathsEqual(codeIndex.statusWorkspace, workspacePath)) {
    return mapCodeIndexState(codeIndex.phase, true)
  }
  return index && index.files > 0 ? 'ready' : 'off'
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
  codeIndex: {
    enabled: boolean
    phase: CodeIndexModelPhase
    /** The workspace that phase belongs to; absent until a sync names one. */
    statusWorkspace?: string
  }
): Promise<WorkspaceAgentContextResult> {
  const [ruleSources, memory, branch] = await Promise.all([
    countWorkspaceRuleSources(workspacePath),
    readMemoryNotes(workspacePath),
    currentBranch(workspacePath)
  ])
  const index = codeIndex.enabled ? readIndexFacts(workspacePath) : null
  return {
    workspaceName: basename(workspacePath),
    branch,
    rules: {
      agentsMd: ruleSources.rootFiles.includes('AGENTS.md'),
      claudeMd: ruleSources.rootFiles.includes('CLAUDE.md'),
      cursorrules: ruleSources.rootFiles.includes('.cursorrules'),
      ruleFileCount: ruleSources.ruleFileCount
    },
    memoryNotes: memory.count,
    ...(memory.names.length > 0 ? { memoryNoteNames: memory.names } : {}),
    codeIndex: {
      state: codeIndexStateFor(workspacePath, codeIndex, index),
      ...(index ? { files: index.files, ...(index.indexedAt ? { indexedAt: index.indexedAt } : {}) } : {})
    }
  }
}
