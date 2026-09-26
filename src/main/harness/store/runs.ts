import { existsSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { atomicWriteFile, atomicWriteJson } from '../../storage/atomicWrite'
import { ensureWorkspaceStorage, resolveRunDir } from '../../storage/paths'
import {
  DONE_WHEN_CHECKS_FILE,
  contractDoneWhenBlock,
  defaultDoneWhenBlock,
  normalizeCheckText,
  type DoneWhenCheck
} from '../../../shared/doneWhenChecks'
import type { AgentInteractionMode, ChatMessage, RunStatus } from '../../../shared/ipc'
import { DEFAULT_PLAN_STUB, stripPlanStubChrome } from '../../../shared/planStub'
import { TOOL_STUB_RESTART_INTERRUPTED } from '../../../shared/toolStubs'
import { toolResultEventForPersistence } from '../../../shared/utils/toolResultIpc'
import { appendEvent, EVENTS_FILE } from './events'
import { forgetStorageLost } from './jsonl'
import { reviveStatus, STATUS_FILE } from './status'
import { appendMessage, MESSAGES_FILE, readTranscript, rewriteTranscript } from './transcript'

export const CONTRACT_FILE = 'contract.md'
export const PLAN_FILE = 'plan.md'
/** The contract rides in the prompt; past this it is cut. */
const CONTRACT_CAP = 4000

export function runExists(workspacePath: string, runId: string): boolean {
  const dir = resolveRunDir(workspacePath, runId)
  return existsSync(join(dir, STATUS_FILE))
}

export type CreateRunOptions = {
  mode?: AgentInteractionMode
  /** The brief's done-when checks: the run's first checks and its contract's Done when. */
  doneWhen?: string[]
  parentRunId?: string
  inlineInstance?: true
  pathScope?: string[]
  worktreePath?: string
  worktreeBranch?: string
}

/** The brief's checks, numbered c1… in the order typed; a repeat is one check. */
function briefChecks(texts: readonly string[], createdAt: string): DoneWhenCheck[] {
  const seen = new Set<string>()
  const checks: DoneWhenCheck[] = []
  for (const raw of texts) {
    const text = raw.trim()
    const key = normalizeCheckText(text)
    if (!text || seen.has(key)) continue
    seen.add(key)
    checks.push({ id: `c${checks.length + 1}`, text, source: 'brief', verdict: null, createdAt })
  }
  return checks
}

/**
 * Create a run directory: contract.md (goal + Done when), status.json,
 * empty messages.jsonl and events.jsonl, and checks.json when the brief had
 * checks. Returns the directory.
 */
export function createRun(workspacePath: string, runId: string, goal: string, options: CreateRunOptions = {}): string {
  const dir = resolveRunDir(workspacePath, runId)
  ensureWorkspaceStorage(workspacePath)
  mkdirSync(dir, { recursive: true })
  reviveStatus(dir)
  forgetStorageLost(dir)
  const now = new Date().toISOString()
  const goalText = goal.trim() || 'chat'
  const checks = briefChecks(options.doneWhen ?? [], now)
  if (checks.length > 0) atomicWriteJson(join(dir, DONE_WHEN_CHECKS_FILE), { checks })
  atomicWriteFile(
    join(dir, CONTRACT_FILE),
    [
      '## Goal',
      '',
      goalText,
      '',
      checks.length > 0 ? contractDoneWhenBlock(checks) : defaultDoneWhenBlock(),
      ''
    ].join('\n')
  )
  const status: RunStatus = {
    status: 'running',
    step: 0,
    updatedAt: now,
    goal: goalText.slice(0, 200),
    workspacePath,
    mode: options.mode ?? 'agent',
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.inlineInstance ? { inlineInstance: true as const } : {}),
    ...(options.pathScope?.length ? { pathScope: options.pathScope } : {}),
    ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
    ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {})
  }
  atomicWriteJson(join(dir, STATUS_FILE), status)
  atomicWriteFile(join(dir, MESSAGES_FILE), '')
  atomicWriteFile(join(dir, EVENTS_FILE), '')
  return dir
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** contract.md as the prompt renders it (capped). */
export async function readContract(dir: string): Promise<string> {
  const text = (await readText(join(dir, CONTRACT_FILE))).trim()
  if (text.length <= CONTRACT_CAP) return text
  return `${text.slice(0, CONTRACT_CAP)}\n…`
}

/** plan.md verbatim, stub included. */
export async function readPlanRaw(dir: string): Promise<string> {
  return (await readText(join(dir, PLAN_FILE))).trim()
}

/**
 * plan.md for the prompt: the file verbatim once it has a real body, '' while
 * it is still the stub every run is seeded with (so an unplanned run pays
 * nothing for it).
 */
export async function readPlan(dir: string): Promise<string> {
  const text = await readPlanRaw(dir)
  if (!text) return ''
  if (stripPlanStubChrome(text).replace(/[_*.\s]/g, '').length < 20) return ''
  return text
}

/**
 * Seed plan.md with the Goal / Steps / Done when stub when missing. Not
 * cosmetic: the plan.md run-artifact remap is gated on the file existing, and
 * an edit to a missing path creates it — without the stub, `edit plan.md`
 * before the first `create_plan` would land in the user's workspace root.
 */
export function ensurePlanStub(dir: string): void {
  const path = join(dir, PLAN_FILE)
  if (!existsSync(path)) atomicWriteFile(path, DEFAULT_PLAN_STUB)
}

/**
 * Close tool calls that never got a result (the process died between dispatch
 * and result). The stand-in says the tool may already have run — a crash
 * cannot promise it did not. Calls orphaned at the tail (the normal case) get
 * their stubs appended; anything earlier (a legacy file) is repaired with one
 * rewrite. Returns how many calls were closed.
 */
export async function closeOrphanToolCalls(dir: string, runId: string): Promise<number> {
  const messages = await readTranscript(dir)
  const answered = new Set<string>()
  for (const m of messages) if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId)

  let lastCallsAt = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant' && messages[i]!.toolCalls?.length) {
      lastCallsAt = i
      break
    }
  }
  const orphanAt: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.toolCalls?.some((c) => !answered.has(c.id))) orphanAt.push(i)
  }
  if (orphanAt.length === 0) return 0

  const stubFor = (call: { id: string; name: string }): ChatMessage => ({
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content: TOOL_STUB_RESTART_INTERRUPTED,
    ok: false
  })
  const writes: Promise<void>[] = []
  const recordStub = (call: { id: string; name: string }): void => {
    writes.push(appendEvent(
      dir,
      toolResultEventForPersistence({
        type: 'tool_result',
        runId,
        toolCallId: call.id,
        name: call.name,
        summary: 'interrupted',
        ok: false,
        content: TOOL_STUB_RESTART_INTERRUPTED
      })
    ))
  }

  // Tail orphans: only the last tool-calling assistant turn is open and
  // nothing but its own results follows it — appending keeps every pairing valid.
  const tailOnly =
    orphanAt.length === 1 &&
    orphanAt[0] === lastCallsAt &&
    messages.slice(lastCallsAt + 1).every((m) => m.role === 'tool')
  let closed = 0
  if (tailOnly) {
    for (const call of messages[lastCallsAt]!.toolCalls!) {
      if (answered.has(call.id)) continue
      answered.add(call.id)
      writes.push(appendMessage(dir, stubFor(call)))
      recordStub(call)
      closed++
    }
    await Promise.all(writes)
    return closed
  }
  const repaired: ChatMessage[] = []
  for (const m of messages) {
    repaired.push(m)
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue
    for (const call of m.toolCalls) {
      if (answered.has(call.id)) continue
      answered.add(call.id)
      repaired.push(stubFor(call))
      recordStub(call)
      closed++
    }
  }
  await Promise.all([rewriteTranscript(dir, repaired), ...writes])
  return closed
}
