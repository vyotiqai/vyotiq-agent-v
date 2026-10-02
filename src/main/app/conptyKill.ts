import { logger } from '../../shared/logger'

/**
 * node-pty's Windows ConPTY `kill()` asks a helper for the console's process
 * list, and starts that helper with `child_process.fork`. The packaged app has
 * the runAsNode fuse off, so Electron refuses the fork; the throw lands as an
 * unhandled rejection inside node-pty, which logging treats as fatal. Closing a
 * terminal tab ended the app.
 *
 * The list only exists so node-pty can kill whatever is still on the console.
 * `killPty` already tree-kills the shell, and closing the pseudoconsole sends
 * every attached process CTRL_CLOSE_EVENT, so the helper is replaced with an
 * empty list. Dev and packaged builds take the same path, so a dev run
 * exercises what ships.
 */

type ConsoleListAgent = { _getConsoleProcessList?: unknown }

let installed = false

function loadAgentPrototype(): ConsoleListAgent | null {
  try {
    const mod = require('node-pty/lib/windowsPtyAgent') as {
      WindowsPtyAgent?: { prototype?: ConsoleListAgent }
    }
    return mod.WindowsPtyAgent?.prototype ?? null
  } catch {
    return null
  }
}

/** No helper process: node-pty kills nothing itself, `killPty` owns the tree. */
function noConsoleProcessList(): Promise<number[]> {
  return Promise.resolve([])
}

/**
 * Replace node-pty's forking console-list helper. Windows only; idempotent.
 * Returns whether the replacement is in place.
 */
export function installForklessConptyKill(
  prototype: ConsoleListAgent | null = loadAgentPrototype(),
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  if (installed && prototype?._getConsoleProcessList === noConsoleProcessList) return true
  if (!prototype || typeof prototype._getConsoleProcessList !== 'function') {
    // node-pty moved its internals: the fork is back, and closing a terminal
    // ends a packaged app again. pipeErrors still catches the refusal.
    logger.warn('node-pty has no console-list helper to replace; terminal close may fork', {
      scope: 'terminal'
    })
    return false
  }
  prototype._getConsoleProcessList = noConsoleProcessList
  installed = true
  return true
}
