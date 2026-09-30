import { applyGitPatch } from '../../git/git'
import { abortError } from '../../../shared/errors'

export type ApplyPatchResult = { ok: boolean; summary: string; content: string }

function unquotePatchPath(raw: string): string {
  const trimmed = raw.trim().replace(/\t.*$/, '')
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

function stripPatchPrefix(raw: string): string | null {
  const path = unquotePatchPath(raw)
  if (!path || path === '/dev/null') return null
  return path.replace(/^[ab]\//, '')
}

/**
 * True when the patch carries git's binary payload. Such a patch encodes the
 * paths inside its base85 blocks, so no `---`/`+++`/`rename` header exposes
 * them and {@link patchTouchedPaths} returns nothing for it.
 */
export function isBinaryGitPatch(patch: string): boolean {
  return patch.split(/\r?\n/).some((line) => line.startsWith('GIT binary patch'))
}

/** A hunk header is the one line in a unified diff that starts with `@@`. */
function isHunkHeader(line: string | undefined): boolean {
  return line?.startsWith('@@') === true
}

/**
 * Whether a `--- `/`+++ ` line starts a real file header pair. The `@@` header
 * that follows the pair is what makes it one; a pair in the middle of a hunk
 * body is just code — a removed line reading `-- x` renders as `--- x` — and
 * must not name a path. The `@@` requirement is also what accepts a file header
 * pair no hunk follows, as in the quoted-path case.
 */
function isFileHeaderStart(line: string, next: string | undefined): boolean {
  if (line.startsWith('--- ')) return next?.startsWith('+++ ') === true
  if (line.startsWith('+++ ')) return isHunkHeader(next)
  return false
}

/**
 * Workspace paths a unified diff writes, as `git apply` (-p1) reads it: the
 * target of every `+++` header, and the source of a deletion (`+++
 * /dev/null`) or rename. Header-only renames name both sides.
 */
export function patchTouchedPaths(patch: string): Array<{ path: string; kind: 'write' | 'delete' }> {
  const out = new Map<string, 'write' | 'delete'>()
  const lines = patch.split(/\r?\n/)
  let from: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('--- ') && isFileHeaderStart(line, lines[i + 1])) {
      from = stripPatchPrefix(line.slice(4))
    } else if (line.startsWith('+++ ') && isFileHeaderStart(line, lines[i + 1])) {
      const to = stripPatchPrefix(line.slice(4))
      if (to) out.set(to, 'write')
      else if (from) out.set(from, 'delete')
      from = null
    } else if (line.startsWith('rename from ')) {
      const path = unquotePatchPath(line.slice('rename from '.length))
      if (path) out.set(path, 'delete')
    } else if (line.startsWith('rename to ')) {
      const path = unquotePatchPath(line.slice('rename to '.length))
      if (path) out.set(path, 'write')
    }
  }
  return [...out].map(([path, kind]) => ({ path, kind }))
}

export async function toolApplyPatchAsync(
  workspace: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<ApplyPatchResult> {
  if (signal.aborted) throw abortError()
  const patch = typeof args.patch === 'string' ? args.patch : ''
  if (!patch.trim()) {
    return { ok: false, summary: 'git apply', content: 'patch is required' }
  }
  const check = args.check === true
  const summary = check ? 'git apply --check' : 'git apply'
  try {
    const result = await applyGitPatch(workspace, patch, { check })
    if (!result.ok) {
      return { ok: false, summary, content: result.error ?? 'git apply failed' }
    }
    const appliedNote =
      result.applied && result.applied.length > 0
        ? `Applied to ${result.applied.length} file(s):\n${result.applied.join('\n')}`
        : check
          ? 'Patch applies cleanly.'
          : 'Patch applied.'
    return { ok: true, summary, content: appliedNote }
  } catch (err) {
    if (signal.aborted) throw err
    return { ok: false, summary, content: (err as Error).message ?? 'git apply failed' }
  }
}
