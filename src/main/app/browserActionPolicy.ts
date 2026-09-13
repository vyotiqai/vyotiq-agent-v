import { existsSync } from 'fs'
import { assertInsideWorkspace } from '../../shared/workspacePath'

/**
 * Action policy for high-risk browser capabilities.
 *
 * | Action   | Default | Notes |
 * |----------|---------|-------|
 * | upload   | allow   | Workspace-scoped path + same approval gate as writes |
 * | download | allow   | Save under workspace only; confirm large/binary |
 * | eval     | deny    | Never expose free-form JS eval to the model |
 * | dialog   | allow   | Agent-only accept/dismiss via browser_handle_dialog |
 */

export type BrowserFutureAction = 'upload' | 'download' | 'eval'

export type BrowserActionDecision = {
  allowed: boolean
  reason: string
}

export function assertBrowserActionAllowed(action: BrowserFutureAction): BrowserActionDecision {
  switch (action) {
    case 'upload':
      return {
        allowed: true,
        reason: 'workspace-scoped path plus the same approval gate as writes'
      }
    case 'download':
      return {
        allowed: true,
        reason: 'save under the workspace with the same approval gate as writes'
      }
    case 'eval':
      return {
        allowed: false,
        reason: 'browser JS eval is denied by policy'
      }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

/** Resolve a file-input path: policy + workspace confinement + exists. */
export function resolveBrowserUploadPath(
  workspacePath: string | undefined,
  relOrAbs: string
): string {
  const decision = assertBrowserActionAllowed('upload')
  if (!decision.allowed) throw new Error(decision.reason)
  const root = workspacePath?.trim()
  if (!root) throw new Error('File uploads require a workspace')
  const abs = assertInsideWorkspace(root, relOrAbs)
  if (!existsSync(abs)) throw new Error(`Upload file not found: ${relOrAbs}`)
  return abs
}
