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
 *   UserPromptSubmit  when an instruction starts or continues a task, before
 *                 the first model step (a follow-up queued mid-run and taken
 *                 in between steps doesn't pass through it). Exit 2 blocks it:
 *                 the instruction is taken out of the task and stderr is the
 *                 error shown. What it prints on exit 0 goes to the agent.
 *   SessionStart  when a task starts or resumes (`source`: startup | resume,
 *                 which `matcher` can name). What it prints goes to the agent.
 *
 * Each hook gets one JSON object on stdin (session_id, cwd, hook_event_name,
 * and tool_name / tool_input / tool_response, message, prompt or source). Any
 * other non-zero exit is logged and changes nothing.
 *
 * Claude Code's JSON on stdout is read where it maps onto the above:
 * `{"decision":"block","reason"}` blocks a PreToolUse call or a prompt,
 * `hookSpecificOutput.permissionDecision: "deny"` blocks a PreToolUse call,
 * and `hookSpecificOutput.additionalContext` is the text that goes to the
 * agent. PreToolUse runs after approval here, so "allow" and "ask" leave the
 * call to the approval that already happened.
 *
 * From `<userData>/hooks.json` (yours, always on) and `<workspace>/.vyotiq/
 * hooks.json`. A workspace's file came with the folder, so its commands run
 * only after the person allows that exact file; a change to it asks again.
 * Events and hook types Agent V doesn't run (a Claude Code `prompt` hook, a
 * `SubagentStop` list) are skipped and logged once, not fatal to the file.
 */

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'SessionStart'
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

const MAX_TIMEOUT_S = 600

const HookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string().trim().min(1),
  /** Seconds; anything over MAX_TIMEOUT_S runs with that. */
  timeout: z.number().positive().optional()
})
type HookCommand = z.infer<typeof HookCommandSchema>

/** A group before its hooks are read one by one: a bad entry drops itself, not the group. */
const HookGroupShape = z.object({
  /** Tool names (SessionStart: the source), as a regular expression over the whole name. Empty or `*`: all. */
  matcher: z.string().optional(),
  hooks: z.array(z.unknown())
})
type HookGroup = { matcher?: string; hooks: HookCommand[] }

/** Only the outer shape is strict; parseHooksFile reads what is inside entry by entry. */
const HooksFileShape = z.object({ hooks: z.record(z.string(), z.unknown()) })
export type HooksFile = { hooks: Partial<Record<HookEvent, HookGroup[]>> }

const DEFAULT_TIMEOUT_S = 60
const OUTPUT_CAP = 16_384

function isHookEvent(name: string): name is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name)
}

function describeSkippedHook(raw: unknown): string {
  const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined
  return typeof type === 'string' && type !== 'command' ? `a "${type}" hook` : 'not a command hook'
}

/**
 * A hooks file (or a Claude Code settings.json, whose other keys are ignored)
 * as the events and command hooks this app runs, plus what it skipped. An
 * error string only when there is no `hooks` object at all.
 */
export function parseHooksFile(raw: unknown): { file: HooksFile; skipped: string[] } | string {
  const outer = HooksFileShape.safeParse(raw)
  if (!outer.success) return outer.error.issues[0]?.message ?? 'invalid'
  const hooks: HooksFile['hooks'] = {}
  const skipped: string[] = []
  for (const [event, value] of Object.entries(outer.data.hooks)) {
    if (!isHookEvent(event)) {
      skipped.push(`${event} (not an event Agent V runs)`)
      continue
    }
    if (!Array.isArray(value)) {
      skipped.push(`${event} (not a list)`)
      continue
    }
    const groups: HookGroup[] = []
    value.forEach((rawGroup, gi) => {
      const group = HookGroupShape.safeParse(rawGroup)
      if (!group.success) {
        skipped.push(`${event}[${gi}] (not a hook group)`)
        return
      }
      const commands: HookCommand[] = []
      group.data.hooks.forEach((rawHook, hi) => {
        const hook = HookCommandSchema.safeParse(rawHook)
        if (hook.success) commands.push(hook.data)
        else skipped.push(`${event}[${gi}].hooks[${hi}] (${describeSkippedHook(rawHook)})`)
      })
      if (commands.length === 0) return
      groups.push(group.data.matcher !== undefined ? { matcher: group.data.matcher, hooks: commands } : { hooks: commands })
    })
    if (groups.length > 0) hooks[event] = groups
  }
  return { file: { hooks }, skipped }
}

type LoadedHooks = { source: 'user' | 'workspace'; path: string; hash: string; file: HooksFile; skipped: string[] }

/** Files whose skipped entries were already logged, by path and content hash. */
const loggedSkips = new Set<string>()

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
  const parsed = parseHooksFile(raw)
  if (typeof parsed === 'string') {
    return `${path} is not a hooks file: ${parsed}`
  }
  const hash = createHash('sha256').update(text).digest('hex')
  if (parsed.skipped.length > 0 && !loggedSkips.has(`${path}\n${hash}`)) {
    loggedSkips.add(`${path}\n${hash}`)
    logger.warn('Hooks file entries skipped', {
      scope: 'agent',
      reason: `${parsed.skipped.length} skipped in ${path}: ${parsed.skipped.slice(0, 12).join(', ')}`
    })
  }
  return { source, path, hash, file: parsed.file, skipped: parsed.skipped }
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
  loggedSkips.clear()
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

/** Claude Code's JSON output, when a hook printed a JSON object on stdout. */
export function hookJsonOutput(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  if (!text.startsWith('{')) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function specificOutput(json: Record<string, unknown> | null): Record<string, unknown> | null {
  const out = json?.hookSpecificOutput
  return out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Why a hook run blocks (exit 2, or JSON `decision: "block"`, or for
 * PreToolUse `permissionDecision: "deny"`), or null when it doesn't.
 */
export function hookBlockReason(run: HookRun, event: HookEvent, fallback: string): string | null {
  if (run.code === 2) return run.stderr.trim() || fallback
  if (run.code !== 0) return null
  const json = hookJsonOutput(run.stdout)
  if (!json) return null
  if (json.decision === 'block') return nonEmptyString(json.reason) ?? fallback
  const specific = specificOutput(json)
  if (event === 'PreToolUse' && specific?.permissionDecision === 'deny') {
    return nonEmptyString(specific.permissionDecisionReason) ?? nonEmptyString(json.reason) ?? fallback
  }
  return null
}

/** What a successful hook adds for the agent: JSON `additionalContext`, else its plain stdout. */
export function hookContext(run: HookRun): string | null {
  if (run.code !== 0) return null
  const json = hookJsonOutput(run.stdout)
  if (json) return nonEmptyString(specificOutput(json)?.additionalContext)
  return nonEmptyString(run.stdout)
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
    signal?: AbortSignal,
    /** A run that ends the event: later hooks would act on something that won't happen. */
    endsEvent?: (run: HookRun) => boolean
  ): Promise<HookRun[]> {
    const runs: HookRun[] = []
    for (const set of this.sets) {
      for (const group of set.file.hooks[event] ?? []) {
        if (!groupMatches(group, toolName)) continue
        for (const hook of group.hooks) {
          const run = await runHookCommand(
            hook.command,
            { session_id: this.ctx.runId, cwd: this.ctx.workspace, hook_event_name: event, ...payload },
            {
              cwd: this.ctx.workspace,
              timeoutMs: Math.min(hook.timeout ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000,
              signal
            }
          )
          if (run.code !== 0 && run.code !== 2) {
            logger.warn(`${event} hook failed; carrying on`, {
              scope: 'agent',
              runId: this.ctx.runId,
              reason: run.timedOut ? 'timed out' : `exit ${run.code ?? 'signal'}: ${run.stderr.trim().slice(0, 300)}`
            })
          }
          runs.push(run)
          if (endsEvent?.(run)) return runs
        }
      }
    }
    return runs
  }

  /** The reason to give the agent when a hook blocks this call, or null to go ahead. */
  async preToolUse(toolName: string, toolInput: unknown, signal?: AbortSignal): Promise<string | null> {
    if (!this.has('PreToolUse')) return null
    const fallback = 'Blocked by a PreToolUse hook.'
    const runs = await this.runAll(
      'PreToolUse',
      toolName,
      { tool_name: toolName, tool_input: toolInput },
      signal,
      (run) => hookBlockReason(run, 'PreToolUse', fallback) !== null
    )
    for (const run of runs) {
      const reason = hookBlockReason(run, 'PreToolUse', fallback)
      if (reason !== null) return reason
    }
    return null
  }

  /**
   * An instruction was sent. `blocked` is why a hook refused it (the task
   * must not act on it); `context` is what the hooks printed for the agent.
   */
  async userPromptSubmit(
    prompt: string,
    signal?: AbortSignal
  ): Promise<{ blocked: string | null; context: string | null }> {
    if (!this.has('UserPromptSubmit')) return { blocked: null, context: null }
    const fallback = 'Blocked by a UserPromptSubmit hook.'
    const runs = await this.runAll(
      'UserPromptSubmit',
      undefined,
      { prompt },
      signal,
      (run) => hookBlockReason(run, 'UserPromptSubmit', fallback) !== null
    )
    for (const run of runs) {
      const reason = hookBlockReason(run, 'UserPromptSubmit', fallback)
      if (reason !== null) return { blocked: reason, context: null }
    }
    const notes = runs.map(hookContext).filter((note): note is string => note !== null)
    return { blocked: null, context: notes.length > 0 ? notes.join('\n\n') : null }
  }

  /** A task started or resumed: what the hooks printed for the agent, or null. */
  async sessionStart(source: 'startup' | 'resume', signal?: AbortSignal): Promise<string | null> {
    if (!this.has('SessionStart')) return null
    const runs = await this.runAll('SessionStart', source, { source }, signal)
    const notes = runs.map(hookContext).filter((note): note is string => note !== null)
    return notes.length > 0 ? notes.join('\n\n') : null
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
    // Exit 2's stderr, or JSON `decision: "block"` with its reason.
    const notes = runs.map((run) => hookBlockReason(run, 'PostToolUse', '')).filter((note): note is string => Boolean(note))
    return notes.length > 0 ? notes.join('\n') : null
  }

  /** Why the agent should keep going, or null to let it finish. */
  async stop(stopHookActive: boolean, signal?: AbortSignal): Promise<string | null> {
    if (!this.has('Stop')) return null
    const runs = await this.runAll('Stop', undefined, { stop_hook_active: stopHookActive }, signal)
    const reasons = runs
      .map((run) => hookBlockReason(run, 'Stop', 'A Stop hook asked to keep going.'))
      .filter((reason): reason is string => reason !== null)
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
