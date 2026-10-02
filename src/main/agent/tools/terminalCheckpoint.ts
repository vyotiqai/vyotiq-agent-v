import { getWriteCheckpoint } from '../checkpoints'
import { looksLikeWorkspacePath } from '../pathPlausibility'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { isAbsolutePathLike } from '../../../shared/extraRoots'
import { resolveInsideRoots, routeExtraRoot } from '../extraRoots'
import { join } from 'path'

/**
 * Conservatively extract workspace-relative write targets from a shell command.
 * Only records paths we can parse with high confidence — no glob expansion.
 */
export function extractTerminalWritePaths(command: string): string[] {
  const raw = command.trim()
  if (!raw) return []

  const found = new Set<string>()

  // Redirections: > path, >> path (not 2>&1 / >&2).
  const redirectRe = /(?:^|[\s;|&])(?:\d*)>>?\s*(?!\d)(?!&)'([^']+)'|(?:^|[\s;|&])(?:\d*)>>?\s*(?!\d)(?!&)"([^"]+)"|(?:^|[\s;|&])(?:\d*)>>?\s*(?!\d)(?!&)([^\s;|&<>]+)/g
  let m: RegExpExecArray | null
  while ((m = redirectRe.exec(raw)) !== null) {
    const path = stripShellTrailer(m[1] ?? m[2] ?? m[3] ?? '')
    if (path && path !== '/dev/null' && path !== 'NUL' && path !== 'nul') {
      found.add(path)
    }
  }

  // Common mutators: cp/mv/rm/del/mkdir/touch/sed -i/patch/dd/git checkout|restore|apply
  const mutatorRe =
    /(?:^|[\s;|&])(?:(?:copy|cp|move|mv|del|rm|rmdir|rd|mkdir|md|touch|ni|New-Item|sed|patch|dd)\b|(?:git\s+(?:checkout|restore|apply)\b))\s+(.+?)(?=(?:[\s;|&](?:&&|\|\||;|\|)\s*)|$)/gi
  while ((m = mutatorRe.exec(raw)) !== null) {
    const tail = (m[1] ?? '').trim()
    if (!tail) continue
    for (const token of tokenizeShellArgs(tail)) {
      if (token.startsWith('-')) continue
      if (token === '--') continue
      if (token.includes('*') || token.includes('?')) continue
      const path = stripShellTrailer(token)
      if (path) found.add(path)
    }
  }

  // PowerShell write cmdlets: Set-Content, Out-File, Add-Content.
  const psWriteRe =
    /\b(?:Set-Content|Out-File|Add-Content)\b(?:\s+-(?:Path|FilePath|LiteralPath)\s+|\s+)('([^']+)'|"([^"]+)"|([^\s;|&<>]+))/gi
  while ((m = psWriteRe.exec(raw)) !== null) {
    const path = stripShellTrailer(m[2] ?? m[3] ?? m[4] ?? '')
    if (path && path !== '/dev/null' && path !== 'NUL' && path !== 'nul') {
      found.add(path)
    }
  }

  // tee / tee -a
  const teeRe = /\btee\b(?:\s+-a)?\s+(['"]?)([^\s'";|&]+)\1/gi
  while ((m = teeRe.exec(raw)) !== null) {
    const path = stripShellTrailer(m[2] ?? '')
    if (path && path !== '/dev/null' && path !== 'NUL' && path !== 'nul') {
      found.add(path)
    }
  }

  return [...found].filter((path) => looksLikeWorkspacePath(path))
}

/** Drop trailing `mkdir src/stores;` separators so the path stays plausible. */
function stripShellTrailer(token: string): string {
  return token.trim().replace(/[;]+$/g, '').trim()
}

function tokenizeShellArgs(tail: string): string[] {
  const tokens: string[] = []
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tail)) !== null) {
    const tok = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (tok) tokens.push(tok)
  }
  return tokens
}

export async function recordTerminalCommandPriors(
  workspaceRoot: string,
  command: string,
  context: { runDir?: string; skipWriteCheckpoint?: boolean },
  /**
   * The command's working directory and the task's added folders
   * (extraRoots.ts): a relative path run from inside an added folder means a
   * file there, and an absolute one may name a file in any of them. Both are
   * recorded under the file's absolute path, as edits there are.
   */
  roots: { cwd?: string; extraRoots?: readonly string[] } = {}
): Promise<void> {
  if (context.skipWriteCheckpoint || !context.runDir) return
  const cp = getWriteCheckpoint(context.runDir)
  if (!cp) return
  const extraRoots = roots.extraRoots ?? []
  const cwdRoot = roots.cwd ? routeExtraRoot(workspaceRoot, extraRoots, roots.cwd) : null

  for (const parsed of extractTerminalWritePaths(command)) {
    const pathArg = cwdRoot && roots.cwd && !isAbsolutePathLike(parsed) ? join(roots.cwd, parsed) : parsed
    try {
      if (extraRoots.length > 0) resolveInsideRoots(workspaceRoot, extraRoots, pathArg)
      else resolveInsideWorkspace(workspaceRoot, pathArg)
    } catch {
      continue
    }
    // Prefer delete semantics for rm/del; otherwise write (covers create + modify).
    const kind = isLikelyDeleteCommand(command, parsed) ? 'delete' : 'write'
    await cp.recordPrior(pathArg, kind, {
      nonEditTool: true,
      ...(kind === 'delete' ? { recursiveDir: true } : {})
    })
  }
}

function isLikelyDeleteCommand(command: string, pathArg: string): boolean {
  const lower = command.toLowerCase()
  if (!/\b(rm|del|rmdir|rd|remove-item)\b/i.test(lower)) return false
  return lower.includes(pathArg.toLowerCase())
}

/** Package managers and build runners often mutate paths the parser cannot see. */
function isLikelyOpaqueCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return /\b(?:npm|pnpm|yarn|npx|bun|cargo|go|make|cmake|gradle|mvn|dotnet|pip|poetry|bundle|rake|mix|docker(?:\s+compose|-compose)?|patch|rsync|terraform|git\s+apply)\b/.test(
    lower
  )
}

/**
 * Full workspace watch only for package managers / build runners that mutate
 * paths the parser cannot see. Read-only commands (python -c, dir, ls, …)
 * must NOT trigger a sync walk. The watch itself is bounded: dependency/cache
 * dirs are skipped, small files get revert blobs, everything else is hashed.
 */
export function needsOpaqueWatch(command: string): boolean {
  return isLikelyOpaqueCommand(command)
}
