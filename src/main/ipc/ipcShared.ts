import { BrowserWindow } from 'electron'
import { ZodError } from 'zod'
import { IPC } from '../../shared/channels'
import { fail, type IpcResult } from '../../shared/ipc'
import { formatError, AppError, isAbortError, isAppError } from '../../shared/errors'
import { logger, logErrorSummary } from '../../shared/logger'
import { getWorkspaces } from '@main/workspace/workspaces'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { getMainWindow } from '@main/app/window'

/* Helpers every IPC handler module shares: who may call, which workspaces, and how a failure is reported. */

export type IpcSender = { sender: Electron.WebContents; senderFrame?: Electron.WebFrameMain | null | undefined }

export function senderOk(event: IpcSender): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed() || win !== mainWindow) return false
  // Electron guidance: validate senderFrame so a compromised subframe cannot
  // invoke privileged handlers.
  const frame = event.senderFrame
  const main = event.sender.mainFrame
  if (frame === undefined && main === undefined) return false
  if (!frame || !main) return false
  if (typeof (frame as { isDestroyed?: () => boolean }).isDestroyed === 'function') {
    if ((frame as { isDestroyed: () => boolean }).isDestroyed()) return false
  }
  return frame === main
}

/** Git runs commands in a directory, so only ever in one the user has opened. */
export function isOpenWorkspace(path: string): boolean {
  return getWorkspaces().openPaths.some((open) => workspacePathsEqual(open, path))
}

export function isExpectedIpcFailure(err: unknown): boolean {
  if (err instanceof AppError && (err.code === 'IPC_CLIENT' || err.code === 'MCP_CONNECT' || err.code === 'MCP_SPAWN')) {
    return true
  }
  const msg = formatError(err)
  // A refusal the user can cause (nothing left to undo, no git remote, a
  // workspace closed under a window that still offers the control) is
  // IPC_CLIENT, not a handler fault to capture as an exception.
  return /no undoable write checkpoint|nothing to undo|no editable harness|already undone|already resolved|checkpoint not found|invalid checkpoint|no harness proposal found|missing a ## Proposed harness body|requires confirm|no git remote|no git remotes|no default remote|not a git repository|unable to determine base repository|could not determine base repository|no initial commit|^workspace is not open$/i.test(
    msg
  )
}

export function failFrom(err: unknown, channel: string, correlationId?: string): IpcResult<never> {
  const isValidation = err instanceof ZodError || (err instanceof AppError && err.code === 'IPC_VALIDATION')
  const message = formatError(err)
  const expected = !isValidation && !isAbortError(err) && isExpectedIpcFailure(err)
  // AppError `err` fields are taxonomy-only; append scrubbed message/cause for ops.
  const summary = isValidation
    ? logErrorSummary(err, 'IPC_VALIDATION')
    : isAbortError(err)
      ? logErrorSummary(err)
      : expected
        ? logErrorSummary(err, 'IPC_CLIENT')
        : logErrorSummary(err, 'IPC_HANDLER')
  const detail =
    isAppError(err) && message && message !== 'Unknown error'
      ? `${summary} — ${message}`
      : summary
  const logLine = isValidation
    ? `IPC validation failed: ${detail}`
    : isAbortError(err)
      ? `IPC aborted: ${detail}`
      : expected
        ? `IPC expected failure: ${detail}`
        : `IPC handler failed: ${detail}`
  const code = isValidation
    ? 'IPC_VALIDATION'
    : isAbortError(err)
      ? undefined
      : expected
        ? 'IPC_CLIENT'
        : 'IPC_HANDLER'
  if (isValidation) {
    logger.warn(logLine, {
      scope: 'ipc',
      code: 'IPC_VALIDATION',
      channel,
      correlationId,
      err,
      reason: message
    })
  } else if (isAbortError(err) || expected) {
    logger.warn(logLine, {
      scope: 'ipc',
      ...(code ? { code } : {}),
      channel,
      correlationId,
      err,
      reason: message
    })
  } else {
    logger.error(logLine, {
      scope: 'ipc',
      code,
      channel,
      correlationId,
      err,
      reason: message
    })
  }
  return fail(message, code)
}

/**
 * Expected user-state rejections (workspace/run checks, rewind index validation)
 * must still reach the log: they were previously returned silently, so a
 * renderer-side `IPC_CLIENT` error had no main-side cause to audit (2026-09-07
 * chatRewindAndStart failures). `reason` is an allow-listed log field and is
 * path/user-data scrubbed by the logger facade.
 */
export function failExpected(
  error: string,
  channel: string,
  correlationId?: string,
  code?: string
): IpcResult<never> {
  logger.warn('IPC expected failure', {
    scope: 'ipc',
    ...(code ? { code } : {}),
    channel,
    ...(correlationId ? { correlationId } : {}),
    reason: error
  })
  return fail(error, code)
}
