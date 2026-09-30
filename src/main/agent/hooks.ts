import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'
import { z } from 'zod'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { killProcessTree, sanitizedTerminalEnv } from './tools/terminal'

/**
 * Hooks: your own commands around the agent's work, in the shape Claude Code
 * uses so an existing hooks file carries over.
 *
 *   PreToolUse    before a tool runs. Exit 2 blocks it; stderr is what the
 *                 agent is told.
 *   PostToolUse   after a tool ran. Exit 2 hands stderr to the agent with
 *                 the result.
 *   Stop          when the agent is about to finish. Exit 2 keeps it going,
 *                 with stderr as the reason.
 *   Notification  when a task needs you. Output is ignored.
 *
 * Each hook gets one JSON object on stdin (session_id, cwd, hook_event_name,
 * and tool_name / tool_input / tool_response or message). Any other non-zero
 * exit is logged and changes nothing.
 *
 * From `<userData>/hooks.json` (yours, always on) and `<workspace>/.vyotiq/
 * hooks.json`. A workspace's file came with the folder, so its commands run
 * only after the person allows that exact file; a change to it asks again.
 */

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'Notification'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

const HookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1),
  /** Seconds. */
  timeout: z.number().positive().max(600).optional()
})

const HookGroupSchema = z.object({
  /** Tool names, as a regular expression over the whole name. Empty or `*`: every tool. */
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema).min(1)
})

export const HooksFileSchema = z.object({
  hooks: z
    .object({
      PreToolUse: z.array(HookGroupSchema).optional(),
      PostToolUse: z.array(HookGroupSchema).optional(),
      Stop: z.array(HookGroupSchema).optional(),
      Notification: z.array(HookGroupSchema).optional()
    })
    .strict()
})
export type HooksFile = z.infer<typeof HooksFileSchema>
type HookGroup = z.infer<typeof HookGroupSchema>

const DEFAULT_TIMEOUT_S = 60
const OUTPUT_CAP = 16_384

type LoadedHooks = { source: 'user' | 'workspace'; path: string; hash: string; file: HooksFile }

export function userHooksPath(): string {
  return join(app.getPath('userData'), 'hooks.json')
}

export function workspaceHooksPath(workspace: string): string {
  return join(workspace, '.vyotiq', 'hooks.json')
}

/** Null when the file is absent; an error string when it is there but unusable. */
export function readHooksFile(path: string, source: LoadedHooks['source']): LoadedHooks | string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
  }
  const parsed = HooksFileSchema.safeParse(raw)
  if (!parsed.success) {
    return `${path} is not a hooks file: ${parsed.error.issues[0]?.message ?? 'invalid'}`
  }
  return { source, path, hash: createHash('sha256').update(text).digest('hex'), file: parsed.data }
}

/** Every command a hooks file would run, for the question that asks to allow them. */
export function hookCommands(file: HooksFile): string[] {
  const out: string[] = []
  for (const event of HOOK_EVENTS) {
    for (const group of file.hooks[event] ?? []) {
      for (const hook of group.hooks) out.push(`${event}${group.matcher ? ` (${group.matcher})` : ''}: ${hook.command}`)
    }
  }
  return out
}

// ── Allowing a workspace's hooks ────────────────────────────────────────────

type TrustFile = { version: 1; workspaces: Record<string, { hash: string; decision: 'allow' | 'deny' }> }

let trustCache: TrustFile | null = null

function trustPath(): string {
  return join(app.getPath('userData'), 'hook-trust.json')
}

function trustKey(workspace: string): string {
  const normalized = resolve(workspace).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function readTrust(): TrustFile {
  if (trustCache) return trustCache
  try {
    const raw = JSON.parse(readFileSync(trustPath(), 'utf8')) as Partial<TrustFile>
    trustCache = { version: 1, workspaces: raw && raw.version === 1 && raw.workspaces ? raw.workspaces : {} }
  } catch {
    trustCache = { version: 1, workspaces: {} }
  }
  return trustCache
}

/** What the person decided about this exact file, if anything. */
export function workspaceHooksDecision(workspace: string, hash: string): 'allow' | 'deny' | null {
  const entry = readTrust().workspaces[trustKey(workspace)]
  return entry && entry.hash === hash ? entry.decision : null
}

export function recordWorkspaceHooksDecision(workspace: string, hash: string, decision: 'allow' | 'deny'): void {
  const trust = readTrust()
  const next: TrustFile = {
    version: 1,
    workspaces: { ...trust.workspaces, [trustKey(workspace)]: { hash, decision } }
  }
  atomicWriteJson(trustPath(), next, 0o600)
  trustCache = next
}

export function resetHooksForTests(): void {
  trustCache = null
}

// ── Running one hook ────────────────────────────────────────────────────────

export type HookRun = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * One hook command, its JSON on stdin. cmd.exe on Windows and /bin/sh
 * elsewhere, because both hand stdin straight to the command they start —
 * the way a hook script expects to read it.
 */
export function runHookCommand(
  command: string,
  input: Record<string, unknown>,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }
): Promise<HookRun> {
  return new Promise((resolveRun) => {
    const [bin, args] =
      process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`]] : ['/bin/sh', ['-c', command]]
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...sanitizedTerminalEnv(), VYOTIQ_PROJECT_DIR: opts.cwd, CLAUDE_PROJECT_DIR: opts.cwd },
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolveRun({ code, stdout: stdout.slice(0, OUTPUT_CAP), stderr: stderr.slice(0, OUTPUT_CAP), timedOut })
    }
    const stop = (): void => {
      if (child.pid != null) killProcessTree(child.pid, 'hook stopped')
    }
    const onAbort = (): void => stop()
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
    // A hook that ignores stdin closes it early; that's fine.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

function groupMatches(group: HookGroup, toolName: string | undefined): boolean {
  const matcher = group.matcher?.trim()
  if (!matcher || matcher === '*' || toolName === undefined) return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName)
  } catch {
    return matcher === toolName
  }
}

// ── A run's hooks ───────────────────────────────────────────────────────────

export type HookAsk = (commands: string[], path: string) => Promise<'allow' | 'deny' | 'unavailable'>

/** The hooks for one run: the person's own, plus the workspace's once allowed. */
export class RunHooks {
  constructor(
    private readonly sets: LoadedHooks[],
    private readonly ctx: { workspace: string; runId: string }
  ) {}

  has(event: HookEvent): boolean {
    return this.sets.some((set) => (set.file.hooks[event]?.length ?? 0) > 0)
  }

  private async runAll(
    event: HookEvent,
    toolName: string | undefined,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<HookRun[]> {
    const runs: HookRun[] = []
    for (const set of this.sets) {
      for (const group of set.file.hooks[event] ?? []) {
        if (!groupMatches(group, toolName)) continue
        for (const hook of group.hooks) {
          const run = await runHookCommand(
            hook.command,
            { session_id: this.ctx.runId, cwd: this.ctx.workspace, hook_event_name: event, ...payload },
            { cwd: this.ctx.workspace, timeoutMs: (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000, signal }
          )
          if (run.code !== 0 && run.code !== 2) {
            logger.warn(`${event} hook failed; carrying on`, {
              scope: 'agent',
              runId: this.ctx.runId,
              reason: run.timedOut ? 'timed out' : `exit ${run.code ?? 'signal'}: ${run.stderr.trim().slice(0, 300)}`
            })
          }
          runs.push(run)
          // A block ends the event: later hooks would act on a call that won't run.
          if (event === 'PreToolUse' && run.code === 2) return runs
        }
      }
    }
    return runs
  }

  /** The reason to give the agent when a hook blocks this call, or null to go ahead. */
  async preToolUse(toolName: string, toolInput: unknown, signal?: AbortSignal): Promise<string | null> {
    if (!this.has('PreToolUse')) return null
    const runs = await this.runAll('PreToolUse', toolName, { tool_name: toolName, tool_input: toolInput }, signal)
    const block = runs.find((run) => run.code === 2)
    return block ? block.stderr.trim() || 'Blocked by a PreToolUse hook.' : null
  }

  /** What a hook wants the agent to know about this result, or null. */
  async postToolUse(
    toolName: string,
    toolInput: unknown,
    toolResponse: { ok: boolean; content: string },
    signal?: AbortSignal
  ): Promise<string | null> {
    if (!this.has('PostToolUse')) return null
    const runs = await this.runAll(
      'PostToolUse',
      toolName,
      { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse },
      signal
    )
    const notes = runs.filter((run) => run.code === 2).map((run) => run.stderr.trim()).filter(Boolean)
    return notes.length > 0 ? notes.join('\n') : null
  }

  /** Why the agent should keep going, or null to let it finish. */
  async stop(stopHookActive: boolean, signal?: AbortSignal): Promise<string | null> {
    if (!this.has('Stop')) return null
    const runs = await this.runAll('Stop', undefined, { stop_hook_active: stopHookActive }, signal)
    const reasons = runs.filter((run) => run.code === 2).map((run) => run.stderr.trim() || 'A Stop hook asked to keep going.')
    return reasons.length > 0 ? reasons.join('\n') : null
  }

  /** Fire and forget. */
  notify(message: string): void {
    if (!this.has('Notification')) return
    void this.runAll('Notification', undefined, { message })
  }
}

/**
 * Load a run's hooks. The workspace's file runs only once allowed; `ask` puts
 * the question to the person (null: never ask — a helper instance, or a
 * notification — and use only what was already allowed).
 */
export async function loadRunHooks(
  workspace: string,
  runId: string,
  ask: HookAsk | null
): Promise<RunHooks> {
  const sets: LoadedHooks[] = []
  for (const [path, source] of [
    [userHooksPath(), 'user'],
    [workspaceHooksPath(workspace), 'workspace']
  ] as const) {
    const loaded = readHooksFile(path, source)
    if (loaded === null) continue
    if (typeof loaded === 'string') {
      logger.warn('Hooks file ignored', { scope: 'agent', runId, reason: loaded })
      continue
    }
    if (source === 'workspace') {
      let decision = workspaceHooksDecision(workspace, loaded.hash)
      if (decision === null && ask) {
        const answer = await ask(hookCommands(loaded.file), path)
        if (answer !== 'unavailable') {
          recordWorkspaceHooksDecision(workspace, loaded.hash, answer)
          decision = answer
        }
      }
      if (decision !== 'allow') continue
    }
    sets.push(loaded)
  }
  return new RunHooks(sets, { workspace, runId })
}

/**
 * Notification hooks for a task that needs the person — an approval or a
 * question. Only hooks already allowed run; this never asks.
 */
export function fireNotificationHooks(workspace: string, runId: string, message: string): void {
  void loadRunHooks(workspace, runId, null)
    .then((hooks) => hooks.notify(message))
    .catch((err: unknown) => {
      logger.warn('Notification hooks failed to load', { scope: 'agent', runId, err })
    })
}
