import { applyGitPatch } from '../../git/git'
import { abortError } from '../../../shared/errors'

export type ApplyPatchResult = { ok: boolean; summary: string; content: string }

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
