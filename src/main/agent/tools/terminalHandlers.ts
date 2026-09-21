import type { AgentToolName } from '../schemas/tools'
import {
  toolTerminal,
  TERMINAL_DEFAULT_TIMEOUT_MS,
  resolveNewCommandBlockUntilMs,
  resolveSessionPollBlockUntilMs
} from './terminal'
import {
  startBackgroundTerminal,
  pollTerminalSession,
  registerTerminalSessionExitFinalize
} from './terminalSessions'
import { parseTerminalOutput } from '../../../shared/utils/terminalFormat'
import { getSettings } from '@main/settings/settings'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import {
  mirrorAgentCommandAborted,
  mirrorAgentCommandEnd,
  mirrorAgentCommandStart,
  mirrorAgentOutput
} from './terminalMirror'
import { needsOpaqueWatch, recordTerminalCommandPriors } from './terminalCheckpoint'
import { startWatch, applyWatchDiffToCheckpoint, diffSince, disposeWatch } from '../workspaceMutationWatch'
import { invalidateAfterWorkspaceMutation, terminalResultOk, toolOk, toolFail } from './index'
import type { ToolHandler } from './index'

/** Prefer the real shell command over a session UUID in logs and timeline titles. */
function terminalResultSummary(command: string, sessionId: string, content: string): string {
  const fromArgs = command.trim()
  if (fromArgs) return fromArgs.slice(0, 80)
  const fromContent = parseTerminalOutput(content).command?.trim() ?? ''
  if (fromContent) return fromContent.slice(0, 80)
  return (sessionId || 'session').slice(0, 80)
}

type CheckpointWatchContext = { runDir?: string; skipWriteCheckpoint?: boolean }

/** Snapshot known + opaque terminal writes for undo. */
async function withTerminalCheckpointWatch<T>(
  workspace: string,
  command: string,
  context: CheckpointWatchContext,
  run: () => Promise<T>
): Promise<T> {
  await recordTerminalCommandPriors(workspace, command, context)
  const snap =
    !context.skipWriteCheckpoint && context.runDir && command.trim() && needsOpaqueWatch(command)
      ? await startWatch(workspace)
      : null
  try {
    return await run()
  } finally {
    if (snap) {
      await applyWatchDiffToCheckpoint(snap, await diffSince(snap), context)
      await disposeWatch(snap)
    }
  }
}

/**
 * Background-terminal variant: the poll window can return while the shell
 * keeps running, so the final diff runs when the session's process exits (via
 * the session exit-finalizer hook) instead of at tool return. Otherwise later
 * mutations escape the write checkpoint and the scoped-commit mutation paths.
 */
async function withBackgroundTerminalCheckpointWatch(
  workspace: string,
  command: string,
  context: CheckpointWatchContext,
  run: (registerExitFinalize: (sessionId: string) => void) => Promise<string>
): Promise<string> {
  await recordTerminalCommandPriors(workspace, command, context)
  const snap =
    !context.skipWriteCheckpoint && context.runDir && command.trim() && needsOpaqueWatch(command)
      ? await startWatch(workspace)
      : null
  let deferred = false
  const diffAndDispose = async (): Promise<void> => {
    if (!snap) return
    try {
      await applyWatchDiffToCheckpoint(snap, await diffSince(snap), context)
      invalidateAfterWorkspaceMutation(workspace)
    } finally {
      await disposeWatch(snap)
    }
  }
  try {
    return await run((sessionId) => {
      if (!snap) return
      deferred = registerTerminalSessionExitFinalize(sessionId, diffAndDispose)
    })
  } finally {
    if (!deferred) await diffAndDispose()
  }
}

export const terminalHandlers = {
  terminal: async (workspace, args, signal, context) => {
    const command = typeof args.command === 'string' ? args.command : ''
    // Command present: ignore session_id (including invented UUIDs) and run the command.
    const sessionId =
      command.trim()
        ? ''
        : typeof args.session_id === 'string' && args.session_id.trim()
          ? args.session_id.trim()
          : ''
    const shell = context.terminalShell ?? getSettings().terminalShell ?? 'auto'
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined
    const rawOnOutput = context.onTerminalOutput
    /**
     * Everything the command prints also goes to the read-only `agent` session
     * so the Terminal panel shows the run live. The model still receives the
     * separately captured stdout/stderr frame — see terminalMirror.ts.
     */
    const onOutput = (chunk: { text: string; stream: 'stdout' | 'stderr' }): void => {
      mirrorAgentOutput(workspace, chunk.text)
      rawOnOutput?.(chunk)
    }
    const workingDirectory =
      typeof args.working_directory === 'string' && args.working_directory.trim()
        ? args.working_directory.trim()
        : ''
    const cwd = workingDirectory
      ? resolveInsideWorkspace(workspace, workingDirectory)
      : workspace

    const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : TERMINAL_DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.max(1, requested)

    // Prefer the session path whenever we have run ownership: wait expiry keeps
    // the process alive and returns session_id (poll) instead of killing it.
    // Legacy kill-on-timeout toolTerminal is only for callers without a run.
    const runId = context.runId
    const invokeId = context.invokeId
    const canUseSession = Boolean(runId && invokeId != null)
    const useSessionApi =
      Boolean(sessionId) || typeof args.block_until_ms === 'number' || (canUseSession && Boolean(command.trim()))

    if (useSessionApi) {
      if (!runId || invokeId == null) {
        return toolFail('terminal', 'session', 'Background terminal requires run ownership')
      }
      const blockUntilMs = sessionId
        ? resolveSessionPollBlockUntilMs(args)
        : resolveNewCommandBlockUntilMs(args)
      // A foreground new command (no explicit ceiling / no background request)
      // should wait for completion and be hard-killed at the ceiling if it
      // never finishes, rather than silently left running. Explicit windows or
      // polls keep the soft-timeout (leave-running, pollable session) behavior.
      const defaultWait = args.timeoutMs == null && args.block_until_ms == null
      const watchCtx: CheckpointWatchContext = {
        runDir: context.runDir,
        skipWriteCheckpoint: context.skipWriteCheckpoint
      }
      mirrorAgentCommandStart(workspace, command, cwd)
      const content = sessionId
        ? await pollTerminalSession({
            runId,
            invokeId,
            sessionId,
            blockUntilMs,
            pattern,
            signal,
            runSignal: context.runSignal,
            onOutput
          })
        : await withBackgroundTerminalCheckpointWatch(
            workspace,
            command,
            watchCtx,
            (registerExitFinalize) =>
              startBackgroundTerminal({
                runId,
                invokeId,
                workspaceRoot: workspace,
                cwd,
                command,
                signal,
                shell,
                pattern,
                blockUntilMs,
                killOnTimeout: defaultWait,
                onOutput,
                onStillRunning: registerExitFinalize
              })
          )
      mirrorAgentCommandEnd(workspace, command, content)
      // New background command may mutate the tree; pure session polls do not.
      if (!sessionId) {
        invalidateAfterWorkspaceMutation(workspace)
      }
      const summary = terminalResultSummary(command, sessionId, content)
      const ok = terminalResultOk(command || 'session', content)
      if (ok) return toolOk('terminal', summary, content)
      return toolFail('terminal', summary, content)
    }

    const watchCtx: CheckpointWatchContext = {
      runDir: context.runDir,
      skipWriteCheckpoint: context.skipWriteCheckpoint
    }
    mirrorAgentCommandStart(workspace, command, cwd)
    let content: string
    try {
      content = await withTerminalCheckpointWatch(workspace, command, watchCtx, () =>
        toolTerminal(workspace, command, signal, {
          timeoutMs,
          shell,
          cwd,
          onOutput
        })
      )
    } catch (err) {
      // Timeout and abort reject instead of returning a frame, so the mirror
      // would otherwise trail off with no ending.
      mirrorAgentCommandAborted(
        workspace,
        command,
        err instanceof Error ? err.message : String(err)
      )
      throw err
    }
    mirrorAgentCommandEnd(workspace, command, content)
    invalidateAfterWorkspaceMutation(workspace)
    const summary = command.slice(0, 80)
    const ok = terminalResultOk(command, content)
    if (ok) return toolOk('terminal', summary, content)
    return toolFail('terminal', summary, content)
  }
} satisfies Partial<Record<AgentToolName, ToolHandler>>
