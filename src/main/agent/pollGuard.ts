import type { ToolCall } from './providers/types'
import { canonicalizeAgentToolName } from './schemas/tools'
import { toolArgsFromCall } from './loopPolicy'
import {
  isTerminalSessionInProgress,
  parseTerminalOutput
} from '../../shared/utils/terminalFormat'
import { summarizeToolArgs } from '../../shared/toolSummary'

/**
 * Poll guard: when the model keeps issuing the same call and getting the same
 * answer, the harness re-runs the call itself between steps and hands it back
 * only when the answer changes or a time budget runs out.
 *
 * Run a1dc71e2 spent 497 of its 793 steps on `ssh` status checks while a
 * container pull ran inside a VM, each check a full model step, until the user
 * cancelled. The terminal's own `block_until_ms` / `pattern` wait only watches
 * a local process's output, so a remote status check has no way to wait, and
 * the circuit breaker counts failures only. Replayed against this guard the
 * run needs about 558 model steps (18 holds): most checks returned moving
 * progress, which the model should see, so only the unchanged stretches go.
 *
 * A re-run here is what the model's next step would have done anyway, at a
 * slower pace, so it only covers terminal polls (see `isRepollableCall`) that
 * run without asking the user (the loop checks the approval gate first).
 */

/** Identical rounds (same calls, same results) before the harness takes over. */
export const POLL_HOLD_AFTER_ROUNDS = 3

/**
 * Waits between harness re-runs. It starts near the pace of a model step, so a
 * change that lands soon is seen about as quickly as the model would have seen
 * it, then backs off; the last entry repeats.
 */
export const POLL_HOLD_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000]

/** Longest one hold runs before the model gets the call back. */
export const POLL_HOLD_BUDGET_MS = 30 * 60_000

export type PolledResult = {
  toolCallId: string
  name: string
  ok: boolean
  /** The handler's own output, before the step appends soft notes to it. */
  content: string
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function terminalCommandOf(args: Record<string, unknown>): string {
  return typeof args.command === 'string' ? args.command.trim() : ''
}

/**
 * A call the harness may repeat without the model: a terminal call that polls
 * an existing session, or runs a command in the foreground. A
 * `block_until_ms: 0` start would put another copy in the background on every
 * re-run.
 *
 * Terminal only, on purpose. Waiting on something outside the workspace is
 * what it gets used for. The same local read three times in a row is a
 * confused model, not a wait: run 87c21f27's 60 `list_dir src/tools` calls sat
 * among unrelated globs and reads, and holding them would only have left a
 * lost run idle.
 */
export function isRepollableCall(call: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  if (canonicalizeAgentToolName(call.name) !== 'terminal') return false
  const args = toolArgsFromCall(call.arguments)
  if (!terminalCommandOf(args)) {
    return typeof args.session_id === 'string' && args.session_id.trim() !== ''
  }
  return args.block_until_ms !== 0
}

/** Name plus arguments in a form that key order and whitespace cannot split. */
function callKey(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  return `${canonicalizeAgentToolName(call.name)}\u0000${stableStringify(toolArgsFromCall(call.arguments))}`
}

/**
 * What a terminal result says, without what changes on every run. A frame
 * opens with a fresh `session_id` and repeats the cwd and command; only the
 * streams, the exit code and a session's status are the answer.
 *
 * Returns null when the result must not be repeated: a new command that is
 * still running would be started again by a re-run.
 */
export function resultFingerprint(
  call: Pick<ToolCall, 'name' | 'arguments'>,
  ok: boolean,
  content: string
): string | null {
  const parsed = parseTerminalOutput(content)
  const isNewCommand = terminalCommandOf(toolArgsFromCall(call.arguments)) !== ''
  if (isNewCommand && isTerminalSessionInProgress(parsed.sessionStatus)) return null
  return [
    ok ? 'ok' : 'fail',
    isNewCommand ? '' : (parsed.sessionStatus ?? ''),
    parsed.exitCode ?? '',
    parsed.stdout,
    parsed.stderr
  ].join('\u0000')
}

/**
 * One step's calls and answers as a single comparable key, or null if any call
 * is out of scope.
 *
 * Only successful answers count. The same failure three times is the model
 * retrying something broken — the loop lets it keep trying on purpose
 * (agentLoopSafety: "no failure cap") — and re-running a failing `cargo test`
 * in the background for half an hour would cost a build per check. All 23
 * real streaks of three or more identical terminal rounds across 81 runs came
 * back ok.
 */
function stepKey(calls: readonly ToolCall[], results: readonly PolledResult[]): string | null {
  if (calls.length === 0 || calls.length !== results.length) return null
  const byId = new Map(results.map((r) => [r.toolCallId, r]))
  const parts: string[] = []
  for (const call of calls) {
    if (!isRepollableCall(call)) return null
    const result = byId.get(call.id)
    if (!result?.ok) return null
    const fingerprint = resultFingerprint(call, result.ok, result.content)
    if (fingerprint == null) return null
    parts.push(`${callKey(call)}\u0001${fingerprint}`)
  }
  return parts.sort().join('\u0002')
}

/**
 * Counts consecutive steps that repeated the same calls and got the same
 * answers. One per invoke; the loop feeds it every step that ran tools.
 */
export class PollGuard {
  private key: string | null = null
  private rounds = 0

  /** Record a finished step; true when the harness should hold instead of stepping. */
  observe(calls: readonly ToolCall[], results: readonly PolledResult[]): boolean {
    const key = stepKey(calls, results)
    if (key == null) {
      this.reset()
      return false
    }
    this.rounds = key === this.key ? this.rounds + 1 : 1
    this.key = key
    return this.rounds >= POLL_HOLD_AFTER_ROUNDS
  }

  /**
   * After a hold saw the answer change: the new answer is the baseline, so the
   * model gets fresh rounds before another hold. After a hold ran out of budget
   * the count is left alone, and the next identical round holds again at once.
   */
  rebase(calls: readonly ToolCall[], results: readonly PolledResult[]): void {
    const key = stepKey(calls, results)
    this.key = key
    this.rounds = key == null ? 0 : 1
  }

  reset(): void {
    this.key = null
    this.rounds = 0
  }
}

export function pollHoldDelayMs(checksDone: number): number {
  const last = POLL_HOLD_DELAYS_MS[POLL_HOLD_DELAYS_MS.length - 1]!
  return POLL_HOLD_DELAYS_MS[checksDone] ?? last
}

export type PollHoldOutcome = {
  /** `changed`: an answer moved. `budget`: it never did. `interrupted`: cancel or a user message. */
  reason: 'changed' | 'budget' | 'interrupted'
  /** Re-runs completed (each re-runs every call in the step). */
  checks: number
  elapsedMs: number
  /** The latest answers; the changed ones when `reason` is `changed`. */
  results: PolledResult[]
}

export type PollHoldOptions = {
  calls: readonly ToolCall[]
  /** The answers the model already has. */
  baseline: readonly PolledResult[]
  rerun: (call: ToolCall) => Promise<{ ok: boolean; content: string }>
  /** Run cancel or a queued user message ends the hold. */
  signal: AbortSignal
  /** Before each wait, so the UI can say when the next check is. */
  onWait?: (info: { checksDone: number; nextInMs: number; elapsedMs: number }) => void
  budgetMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function sameAnswers(
  calls: readonly ToolCall[],
  a: readonly PolledResult[],
  b: readonly PolledResult[]
): boolean {
  for (const call of calls) {
    const left = a.find((r) => r.toolCallId === call.id)
    const right = b.find((r) => r.toolCallId === call.id)
    if (!left || !right) return false
    const lf = resultFingerprint(call, left.ok, left.content)
    const rf = resultFingerprint(call, right.ok, right.content)
    if (lf == null || rf == null || lf !== rf) return false
  }
  return true
}

/** Re-run the step's calls on a backoff until an answer changes, the budget runs out, or the signal fires. */
export async function runPollHold(options: PollHoldOptions): Promise<PollHoldOutcome> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const budgetMs = options.budgetMs ?? POLL_HOLD_BUDGET_MS
  const startedAt = now()
  let checks = 0
  let latest: PolledResult[] = [...options.baseline]
  const finish = (reason: PollHoldOutcome['reason']): PollHoldOutcome => ({
    reason,
    checks,
    elapsedMs: now() - startedAt,
    results: latest
  })

  for (;;) {
    const delay = pollHoldDelayMs(checks)
    if (now() - startedAt + delay > budgetMs) return finish('budget')
    options.onWait?.({ checksDone: checks, nextInMs: delay, elapsedMs: now() - startedAt })
    await sleep(delay, options.signal)
    if (options.signal.aborted) return finish('interrupted')

    const results: PolledResult[] = []
    for (const call of options.calls) {
      let outcome: { ok: boolean; content: string }
      try {
        outcome = await options.rerun(call)
      } catch (err) {
        if (options.signal.aborted) return finish('interrupted')
        // A handler that throws is news the model should see, not a reason to fail the run.
        outcome = { ok: false, content: err instanceof Error ? err.message : String(err) }
      }
      results.push({ toolCallId: call.id, name: call.name, ...outcome })
    }
    if (options.signal.aborted) return finish('interrupted')
    checks++
    const changed = !sameAnswers(options.calls, options.baseline, results)
    latest = results
    if (changed) return finish('changed')
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** One line for the tool row while a hold waits. */
export function pollHoldProgressText(info: { checksDone: number; nextInMs: number }): string {
  const next = `next check in ${formatDuration(info.nextInMs)}`
  if (info.checksDone === 0) return `Same result ${POLL_HOLD_AFTER_ROUNDS} times · re-checking without the model · ${next}`
  return `Unchanged after ${info.checksDone} re-check${info.checksDone === 1 ? '' : 's'} · ${next}`
}

/** The row's closing line once a hold ends. */
export function pollHoldDoneText(outcome: PollHoldOutcome): string {
  const span = `${outcome.checks} re-check${outcome.checks === 1 ? '' : 's'} over ${formatDuration(outcome.elapsedMs)}`
  if (outcome.reason === 'changed') return `Result changed · ${span}`
  if (outcome.reason === 'budget') return `No change · ${span}`
  return `Stopped · ${span}`
}

/**
 * The synthetic turn that hands the call back to the model. It carries the
 * latest answer only when that answer is new; an unchanged one is already in
 * the tool result above it.
 */
export function pollHoldNote(calls: readonly ToolCall[], outcome: PollHoldOutcome): string {
  const what = calls.length === 1 ? 'the same call' : `the same ${calls.length} calls`
  const lead = `[Poll hold] Your last ${POLL_HOLD_AFTER_ROUNDS} steps ran ${what} and got the same result, so the harness re-ran ${calls.length === 1 ? 'it' : 'them'} for you between steps instead of starting a step each time.`
  const span = `${outcome.checks} re-check${outcome.checks === 1 ? '' : 's'} over ${formatDuration(outcome.elapsedMs)}`
  if (outcome.reason === 'changed') {
    const blocks = outcome.results.map((result) => {
      const call = calls.find((c) => c.id === result.toolCallId)
      const summary = call ? summarizeToolArgs(call.name, call.arguments) : ''
      const head = `--- ${result.name}${summary ? ` · ${summary}` : ''} (${result.ok ? 'ok' : 'failed'}) ---`
      return `${head}\n${result.content}`
    })
    return `${lead} After ${span}, the result changed. Latest result:\n\n${blocks.join('\n\n')}`
  }
  if (outcome.reason === 'budget') {
    return `${lead} After ${span}, the result has not changed. Don't keep polling with repeated steps: to wait on something, wait inside one terminal command (a loop with sleep, or block_until_ms with pattern), or check a signal that shows progress.`
  }
  return `${lead} After ${span}, the result had not changed when the run was interrupted.`
}
