import { readFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import type { AgentEvent, AgentInteractionMode } from '../../shared/ipc'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { clearRunAbort, streamSignalFor } from '../agent/runRegistry'
import { createApprovalGate, type ToolApprovalGate } from '../agent/toolApproval'
import { persistAlwaysAllow } from '../agent/toolApprovalStore'
import { getSettings } from '../settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '../workspace/workspaces'
import { resolveEffectiveSettings } from '../../shared/effectiveSettings'
import { DEFAULT_SETTINGS } from '../../shared/ipc'
import { createRun, runExists, updateStatus } from '../agent/state'
import { resolveRunDir } from '../storage/paths'

type FixtureFile = {
  events: unknown[]
}

const DEFAULT_FIXTURE_REL = join('tests', 'gui-e2e', 'fixtures', 'chat-send-stream.json')

export function isChatFixtureReplayEnabled(): boolean {
  // Vitest sets VITEST=true; never hijack chatStart during unit/integration runs
  // even if VYOTIQ_E2E_FIXTURE leaked into the shell from a prior gui-e2e launch.
  if (process.env.VITEST === 'true') return false
  return process.env.VYOTIQ_E2E_FIXTURE === '1'
}

/** Absolute path or path relative to repo cwd (`VYOTIQ_E2E_FIXTURE_FILE`). */
export function resolveChatFixturePath(): string {
  const override = process.env.VYOTIQ_E2E_FIXTURE_FILE?.trim()
  if (override) {
    return isAbsolute(override) ? override : join(process.cwd(), override)
  }
  return join(process.cwd(), DEFAULT_FIXTURE_REL)
}

function loadFixtureTemplates(): Omit<AgentEvent, 'runId' | 'invokeId'>[] {
  const fixturePath = resolveChatFixturePath()
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureFile
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    throw new Error(`Fixture ${fixturePath} must contain a non-empty events array`)
  }
  return raw.events.map((event, index) => {
    if (isFixtureApproval(event)) return event as unknown as Omit<AgentEvent, 'runId' | 'invokeId'>
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`Fixture event ${index} must be an object`)
    }
    const type = (event as { type?: unknown }).type
    if (typeof type !== 'string' || !type) {
      throw new Error(`Fixture event ${index} missing type`)
    }
    return event as Omit<AgentEvent, 'runId' | 'invokeId'>
  })
}

/**
 * A fixture step that asks for a real approval through the run's real gate:
 * main holds it as pending — the navigator, Home and the record read it from
 * there — the window gets the request, and the run waits for the answer as it
 * would before any gated tool. Allowed, the step's scripted result follows;
 * denied or timed out, the gate's refusal does.
 */
type FixtureApproval = {
  type: '__approval'
  toolCallId: string
  name: string
  /** The tool call's raw JSON arguments. */
  arguments: string
  summary: string
  /** What the tool returns when allowed — the fixture never runs it. */
  result: string
}

function isFixtureApproval(template: unknown): template is FixtureApproval {
  return (template as { type?: unknown }).type === '__approval'
}

/**
 * One gate for the replay, as the loop has one per invoke: the workspace's own
 * standing allows, and "Always allow" saved where a real run saves it — so a
 * fixture step exercises what the loop does with both. Mode stays 'all': a
 * fixture step exists to ask.
 */
function fixtureApprovalGate(input: { runId: string; invokeId: number; workspacePath: string }, signal: AbortSignal): ToolApprovalGate {
  const effective = resolveEffectiveSettings(
    getSettings(),
    findWorkspaceSettingsOverride(readWorkspacesState(), input.workspacePath)
  )
  return createApprovalGate({
    runId: input.runId,
    invokeId: input.invokeId,
    mode: 'all',
    workspaceAllowlist: (effective.toolApproval ?? DEFAULT_SETTINGS.toolApproval).allowlist,
    signal,
    persistAlways: (toolName) => persistAlwaysAllow(input.workspacePath, toolName)
  })
}

async function* askFixtureApproval(
  step: FixtureApproval,
  input: { runId: string; invokeId: number },
  gate: ToolApprovalGate
): AsyncGenerator<AgentEvent> {
  const verdict = await gate.authorize({ id: step.toolCallId, name: step.name, arguments: step.arguments })
  const base = { runId: input.runId, invokeId: input.invokeId, toolCallId: step.toolCallId, name: step.name, summary: step.summary }
  if (verdict.allowed) {
    yield { type: 'tool_start', ...base }
    yield { type: 'tool_result', ...base, ok: true, content: step.result }
    return
  }
  yield { type: 'tool_result', ...base, ok: false, content: verdict.reason }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Replays recorded chat:event payloads for GUI e2e (VYOTIQ_E2E_FIXTURE=1).
 * Skips runAgent / live LLM while exercising the renderer stream path.
 */
export async function* replayChatFixture(input: {
  runId: string
  invokeId: number
  workspacePath: string
  runSignal: AbortSignal
  goal?: string
  mode?: AgentInteractionMode
  agentProfileId?: string
  delegatedTaskId?: string
  /** A new task's checks — the run is created as runAgent would create it. */
  doneWhen?: string[]
}): AsyncGenerator<AgentEvent> {
  const signal = streamSignalFor(input.runId, input.runSignal)
  // The fixture replaces the whole event stream, so `runAgent` — and with it
  // `createRun` and every `writeStatus` — never executes. Without this a
  // fixture run leaves no run directory and no status.json at all, and anything
  // that reads a run's durable outcome sees nothing: a delegated task falls
  // through to the scheduler's MISSING_STATUS_SWEEP_LIMIT and is reported as
  // failed sixty seconds after it streamed perfectly.
  const runDir = resolveRunDir(input.workspacePath, input.runId)
  if (!runExists(input.workspacePath, input.runId)) {
    createRun(input.workspacePath, input.runId, input.goal ?? 'chat', {
      mode: input.mode ?? 'agent',
      ...(input.doneWhen?.length ? { doneWhen: input.doneWhen } : {})
    })
  }
  const persistStatus = async (status: 'done' | 'error' | 'cancelled'): Promise<void> => {
    try {
      await updateStatus(
        runDir,
        {
          status,
          ...(input.agentProfileId ? { agentProfileId: input.agentProfileId } : {}),
          ...(input.delegatedTaskId ? { delegatedTaskId: input.delegatedTaskId } : {})
        },
        { sync: true }
      )
    } catch (err) {
      logger.warn('Fixture replay could not persist run status', {
        scope: 'e2e',
        correlationId: input.runId,
        err
      })
    }
  }
  try {
    const templates = loadFixtureTemplates()
    let gate: ToolApprovalGate | null = null
    for (const template of templates) {
      if (signal.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
      if (isFixtureApproval(template)) {
        gate ??= fixtureApprovalGate(input, signal)
        yield* askFixtureApproval(template, input, gate)
        continue
      }
      const event = {
        ...template,
        runId: input.runId,
        invokeId: input.invokeId
      } as AgentEvent
      if (event.type === 'text_delta') {
        await sleep(8)
      } else if (event.type === 'tool_call_delta') {
        // Wide enough for the renderer + Playwright to observe mid-stream paints.
        await sleep(350)
      }
      if (
        event.type === 'status' &&
        (event.status === 'done' || event.status === 'error' || event.status === 'cancelled')
      ) {
        // Written BEFORE the event is yielded, so anything that reacts to the
        // terminal event finds the durable status already in place.
        await persistStatus(event.status)
      }
      yield event
      if (signal.aborted) {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        throw err
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      await persistStatus('cancelled')
      yield { type: 'status', runId: input.runId, invokeId: input.invokeId, status: 'cancelled' }
      return
    }
    throw err
  } finally {
    clearRunAbort(input.runId, input.invokeId)
  }
}
