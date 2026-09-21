/**
 * Agent-built tools live under Electron userData, outside the project tree
 * (same resolution approach as agent/indexStoragePaths.ts).
 */
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

/** Bootstrap module the runner forks for every tool execution. */
export const RUNNER_BOOTSTRAP_FILENAME = '.runner-bootstrap.cjs'

const FALLBACK_AGENT_TOOLS_DIR = join(tmpdir(), 'vyotiq-agent-tools')

let agentToolsDirOverride: string | null = null
let resolvedAgentToolsDir: string | null = null

/** Vitest: point the tools dir at an isolated temp tree. */
export function setAgentToolsDirOverrideForTests(root: string | null): void {
  agentToolsDirOverride = root
}

/**
 * Electron userData dir, or null outside Electron. Dynamic import keeps this
 * module loadable (and mockable via vi.mock('electron')) in unit tests.
 */
async function electronUserDataDir(): Promise<string | null> {
  try {
    const electron = (await import('electron')) as typeof import('electron')
    if (electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData')
    }
  } catch {
    /* not running inside Electron */
  }
  return null
}

/**
 * Directory holding agent-built tool modules, as currently known.
 *
 * Synchronous, so it answers with the tmpdir fallback until something has
 * resolved userData. Read paths must use `resolveAgentToolsDir()` instead:
 * calling this one directly meant a fresh process scanned the fallback and
 * found nothing, so every tool written by an earlier session stayed invisible
 * until `build_tool` happened to run again and resolve the real directory.
 */
export function agentToolsDir(): string {
  return agentToolsDirOverride ?? resolvedAgentToolsDir ?? FALLBACK_AGENT_TOOLS_DIR
}

/** Resolve the tools dir (userData inside Electron) WITHOUT creating it. */
export async function resolveAgentToolsDir(): Promise<string> {
  if (!agentToolsDirOverride && !resolvedAgentToolsDir) {
    const userData = await electronUserDataDir()
    if (userData) resolvedAgentToolsDir = join(userData, 'agent-tools')
  }
  return agentToolsDir()
}

/** Create the tools dir if missing (fs/promises only); resolves userData on first call. */
export async function ensureAgentToolsDir(): Promise<string> {
  const dir = await resolveAgentToolsDir()
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Validate a tool name for filesystem use: lowercase, [a-z0-9_-], max 32 chars.
 * Returns null when the name is empty, too long, or contains other characters.
 */
export function pathSafeName(name: string): string | null {
  const trimmed = name.trim().toLowerCase()
  if (!trimmed || trimmed.length > 32) return null
  return /^[a-z0-9][a-z0-9_-]*$/.test(trimmed) ? trimmed : null
}

const RUNNER_BOOTSTRAP_SOURCE = `'use strict'
// Agent tool runner bootstrap: Node builtins only (no child_process, no electron).
// Reads <modulePath> <argsJson> <callId> from the last three argv entries,
// dynamic-imports the .mjs tool, invokes handler(args, ctx), and posts the
// result to the parent.
const [modPath, argsJsonRaw, callId] = process.argv.slice(-3)
const argsJson = argsJsonRaw || '{}'
const id = callId || ''
const post = (msg) => {
  try {
    if (process.parentPort) process.parentPort.postMessage(msg)
    else if (process.send) process.send(msg)
  } catch (_) {
    /* parent gone */
  }
}
post({ type: 'ready', id })
Promise.resolve()
  .then(() => import(require('url').pathToFileURL(modPath).href))
  .then(async (mod) => {
    if (typeof mod.handler !== 'function') {
      throw new Error('Tool module must export async function handler(args, ctx)')
    }
    const result = await mod.handler(JSON.parse(argsJson), { callId: id, toolModule: modPath })
    post({ type: 'result', ok: true, result: result === undefined ? null : result, id })
  })
  .catch((err) => {
    post({
      type: 'result',
      ok: false,
      error: err && err.message ? err.message : String(err),
      id
    })
  })
`

/**
 * Write the runner bootstrap into the tools dir. Called before forking; the
 * file contains only Node builtins and is safe to rewrite on every run.
 */
export async function writeRunnerBootstrap(dir: string): Promise<string> {
  const bootstrapPath = join(dir, RUNNER_BOOTSTRAP_FILENAME)
  await writeFile(bootstrapPath, RUNNER_BOOTSTRAP_SOURCE, 'utf8')
  return bootstrapPath
}
