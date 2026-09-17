/**
 * Runs an agent-built tool in an Electron utilityProcess child. Tests inject a
 * fake spawn (DI seam) — the production path lazily requires electron so this
 * module stays loadable without it. Never child_process; fs via fs/promises.
 */
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { RUNNER_BOOTSTRAP_FILENAME, writeRunnerBootstrap } from './paths'
import type { AgentToolDef, AgentToolRuntimeResult } from './types'

export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 30_000
/**
 * Grace period after the child's 'exit' before we call it a no-result exit.
 * The child posts its result and then falls off the end of the script, and
 * postMessage/process.send are async — the parent can dispatch 'exit' before
 * the already-queued 'message'. Without this window the runner rejects a call
 * that actually succeeded (observed flaky on Windows).
 */
const EXIT_SETTLE_GRACE_MS = 100

/** Minimal child surface the runner needs from any spawn implementation. */
export type RunnerChild = {
  onMessage: (cb: (msg: unknown) => void) => void
  onExit?: (cb: () => void) => void
  kill: () => void
}

export type AgentToolSpawnRequest = {
  /** Fork entry: the .runner-bootstrap.cjs next to the tool module. */
  bootstrapPath: string
  /** Absolute path of the tool .mjs to import inside the child. */
  toolModulePath: string
  /** JSON-serialized handler args. */
  argsJson: string
  /** Unique per-call id echoed back by the child. */
  callId: string
}

export type AgentToolSpawn = (req: AgentToolSpawnRequest) => RunnerChild

/** Production spawn: Electron utilityProcess.fork on the bootstrap module. */
export function defaultAgentToolSpawn(): AgentToolSpawn {
  return (req) => {
    // Lazy require: keeps unit tests (no Electron runtime) able to load this module.
    const { utilityProcess } = require('electron') as typeof import('electron')
    const child = utilityProcess.fork(
      req.bootstrapPath,
      [req.toolModulePath, req.argsJson, req.callId],
      { serviceName: 'agent-tool-runner' }
    )
    return {
      onMessage: (cb) => child.on('message', cb),
      onExit: (cb) => child.on('exit', () => cb()),
      kill: () => child.kill()
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Runner factory — the DI seam. Tests pass a fake spawn; production uses defaultAgentToolSpawn(). */
export function createAgentToolRunner(spawn: AgentToolSpawn) {
  return async function runAgentToolWithSpawn(
    def: AgentToolDef,
    args: unknown,
    { timeoutMs = DEFAULT_AGENT_TOOL_TIMEOUT_MS }: { timeoutMs?: number } = {}
  ): Promise<AgentToolRuntimeResult> {
    const started = Date.now()
    const callId = randomUUID()
    return await new Promise<AgentToolRuntimeResult>((resolve, reject) => {
      let settled = false
      let child: RunnerChild | null = null
      let exitTimer: ReturnType<typeof setTimeout> | null = null
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child?.kill()
        reject(new Error(`Agent tool "${def.name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (exitTimer) clearTimeout(exitTimer)
        try {
          child?.kill()
        } catch {
          /* child already gone */
        }
        fn()
      }
      try {
        child = spawn({
          bootstrapPath: join(dirname(def.modulePath), RUNNER_BOOTSTRAP_FILENAME),
          toolModulePath: def.modulePath,
          argsJson: JSON.stringify(args ?? {}),
          callId
        })
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
        return
      }
      child.onMessage((raw) => {
        if (!isRecord(raw)) return
        if (raw.type === 'result') {
          settle(() =>
            resolve({
              ok: raw.ok === true,
              result: raw.result,
              error: typeof raw.error === 'string' ? raw.error : undefined,
              durationMs: Date.now() - started
            })
          )
        } else if (raw.type === 'error') {
          settle(() => reject(new Error(typeof raw.message === 'string' ? raw.message : 'Agent tool child failed')))
        }
      })
      child.onExit?.(() => {
        // Let a message queued just before exit win the race (see grace const).
        if (settled || exitTimer) return
        exitTimer = setTimeout(() => {
          settle(() => reject(new Error(`Agent tool "${def.name}" child exited before sending a result`)))
        }, EXIT_SETTLE_GRACE_MS)
      })
    })
  }
}

let defaultRunner: ReturnType<typeof createAgentToolRunner> | null = null

/** Public entry: ensures the bootstrap exists next to the tool module, then forks. */
export async function runAgentTool(
  def: AgentToolDef,
  args: unknown,
  options: { timeoutMs?: number; spawn?: AgentToolSpawn } = {}
): Promise<AgentToolRuntimeResult> {
  const runner = options.spawn
    ? createAgentToolRunner(options.spawn)
    : (defaultRunner ??= createAgentToolRunner(defaultAgentToolSpawn()))
  // Bootstrap must exist where the forked entry lives; the rewrite is idempotent.
  await writeRunnerBootstrap(dirname(def.modulePath))
  return await runner(def, args, { timeoutMs: options.timeoutMs })
}
