import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { FILE_LIST_WALK_CAP, peekWorkspaceFileListCached } from '../workspace/fileListCache'

/**
 * Built-in tools that cannot do anything in this workspace, left off the wire.
 * A one-line question sent 58 definitions (48k characters): with no MCP
 * server, the MCP server tools still went (2.6k characters); with no git
 * remote, the GitHub read tools (2.5k); with no notebook, edit_notebook (1.1k).
 *
 * Each fact is read once when the run starts and kept for the run, except
 * MCP, which follows the servers the loop already re-reads; the tool array
 * leads the request, so changing it mid-run would void the prompt cache.
 * Every test leans toward keeping a tool: a wrong drop costs a capability, a
 * wrong keep costs only tokens.
 */

/** Ask a connected server; nothing to ask without one. */
const MCP_SERVER_TOOLS = ['mcp_list_tools', 'mcp_list_resources', 'mcp_read_resource', 'mcp_list_prompts', 'mcp_get_prompt']
/**
 * Read or act on a repository that is already on GitHub. github_pr_create
 * stays: with no remote it sets one up. Any remote at all keeps them, since
 * an Enterprise host is not named github.com.
 */
const GIT_REMOTE_TOOLS = ['github_pr_review', 'github_issue', 'github_pr_checks', 'github_pr_comments']
const NOTEBOOK_TOOLS = ['edit_notebook']

export type ToolApplicability = {
  /** At least one MCP server is enabled for this run. */
  mcpServers: boolean
  /** The checkout has a git remote, or that could not be ruled out. */
  gitRemote: boolean
  /** The workspace may hold a notebook. */
  notebooks: boolean
}

export function dropInapplicableTools<T extends { name: string }>(tools: readonly T[], applies: ToolApplicability): T[] {
  const drop = new Set<string>([
    ...(applies.mcpServers ? [] : MCP_SERVER_TOOLS),
    ...(applies.gitRemote ? [] : GIT_REMOTE_TOOLS),
    ...(applies.notebooks ? [] : NOTEBOOK_TOOLS)
  ])
  return drop.size === 0 ? [...tools] : tools.filter((t) => !drop.has(t.name))
}

/** The git config this checkout reads remotes from: a worktree's lives in the common dir. */
function gitConfigPath(workspace: string): string | null {
  const dotGit = join(workspace, '.git')
  if (!existsSync(dotGit)) return null
  if (statSync(dotGit).isDirectory()) return join(dotGit, 'config')
  // A worktree or submodule: `.git` is a file naming the real git dir.
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
  if (!pointer) return null
  const gitDir = isAbsolute(pointer) ? pointer : resolve(workspace, pointer)
  const common = join(gitDir, 'commondir')
  if (existsSync(common)) {
    const rel = readFileSync(common, 'utf8').trim()
    return join(isAbsolute(rel) ? rel : resolve(gitDir, rel), 'config')
  }
  return join(gitDir, 'config')
}

/** True unless the git config was read and names no remote. No git process: this runs at every run start. */
export function mayHaveGitRemote(workspace: string): boolean {
  try {
    const config = gitConfigPath(workspace)
    if (!config) return false
    return /^\s*\[remote\s+"/m.test(readFileSync(config, 'utf8'))
  } catch {
    return true
  }
}

/** False only when the workspace's whole file list is already cached and holds no .ipynb. Never walks the tree. */
export function mayHaveNotebooks(workspace: string): boolean {
  const files = peekWorkspaceFileListCached(workspace)
  if (!files || files.length >= FILE_LIST_WALK_CAP) return true
  return files.some((f) => f.toLowerCase().endsWith('.ipynb'))
}
