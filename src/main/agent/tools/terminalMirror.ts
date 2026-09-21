import { parseTerminalExitCode } from './terminal'
import { writeTerminalMirror } from './terminalMirrorSink'

/**
 * Mirror the run's shell activity into the Terminal panel.
 *
 * The commands themselves still run through `child_process.spawn`: the tool
 * result the model reads is assembled from separate stdout and stderr plus a
 * real exit code, and every classifier around it (findstr-no-match, probe
 * no-target, remote-grep, elevation-denied, dir-missing) reads those streams
 * independently. A PTY merges them into one stream and reports no exit code,
 * so running the tool inside one would change what the model sees. This module
 * copies the same bytes to a read-only session instead, which is what makes
 * the panel live without touching the agent's contract.
 */

const DIM = '[2m'
const RESET = '[0m'
const RED = '[31m'

/** Keep one mirrored command header from running away with a pasted script. */
const MAX_MIRRORED_COMMAND_CHARS = 2_000

function oneLine(command: string): string {
  const flat = command.replace(/\r?\n/g, ' ').trim()
  return flat.length > MAX_MIRRORED_COMMAND_CHARS
    ? `${flat.slice(0, MAX_MIRRORED_COMMAND_CHARS)}…`
    : flat
}

/** Announce a command the run is about to execute. */
export function mirrorAgentCommandStart(
  workspaceRoot: string,
  command: string,
  cwd?: string
): void {
  const flat = oneLine(command)
  if (!flat) return
  const where = cwd && cwd !== workspaceRoot ? ` ${DIM}(${cwd})${RESET}` : ''
  writeTerminalMirror(workspaceRoot, `\n${DIM}agent${RESET} $ ${flat}${where}\n`)
}

/** Copy one stdout/stderr chunk as it streams. */
export function mirrorAgentOutput(workspaceRoot: string, text: string): void {
  if (!text) return
  writeTerminalMirror(workspaceRoot, text)
}

/**
 * Close out a command with the exit code the model was given — read back from
 * the formatted frame rather than recomputed, so the two can never disagree.
 */
export function mirrorAgentCommandEnd(
  workspaceRoot: string,
  command: string,
  content: string
): void {
  if (!oneLine(command)) return
  const code = parseTerminalExitCode(content)
  if (code == null) {
    writeTerminalMirror(workspaceRoot, '\n')
    return
  }
  const tone = code === 0 ? DIM : RED
  writeTerminalMirror(workspaceRoot, `${tone}exit ${code}${RESET}\n`)
}

/** Note a command that ended without a frame (aborted, timed out, threw). */
export function mirrorAgentCommandAborted(
  workspaceRoot: string,
  command: string,
  reason: string
): void {
  if (!oneLine(command)) return
  writeTerminalMirror(workspaceRoot, `${RED}${reason}${RESET}\n`)
}
