import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod'
import {
  AgentInteractionModeSchema,
  ChatMessageSchema,
  TOOL_IMAGE_ARTIFACT_RE,
  type ChatMessage,
  type PersistedEvent
} from '../../shared/ipc'
import { DONE_WHEN_CHECKS_FILE, DoneWhenChecksFileSchema } from '../../shared/doneWhenChecks'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'
import { taskTitleFromGoal } from '../../shared/utils/taskTitle'
import { atomicWriteBuffer, atomicWriteFile, atomicWriteJson } from '../storage/atomicWrite'
import { resolveRunDir } from '../storage/paths'
import { MAX_TOOL_IMAGE_BYTES } from './context/toolImages'
import { redactForRecord } from './recordRedaction'
import { invalidateListRunsCache } from './runListCache'
import {
  createRun,
  loadEventsAsync,
  loadMessagesAsync,
  loadStatus,
  runExists,
  syncEventsAsync,
  syncMessagesAsync,
  updateStatus
} from './state'
import { sniffImageFormat } from './toolImageStore'

/**
 * A task as one self-describing JSON file — Export as JSON writes it, Import
 * task… reads it back. It carries what the record is drawn from (the
 * transcript, the event log, the contract, plan and checks, and the images
 * tools stored), with secrets redacted the way the record redacts them.
 *
 * An import is always a new task with a new id in the workspace it is read
 * into, finished and read-only: nothing it holds is resumed, and its write
 * checkpoints are not carried, so nothing in it can undo a file here.
 */

export const RUN_BUNDLE_FORMAT = 'vyotiq-task'
export const RUN_BUNDLE_VERSION = 1

/** Largest bundle written or read. */
export const RUN_BUNDLE_MAX_BYTES = 64 * 1024 * 1024
/** Image bytes one bundle carries; past it, the rest are left out (the record shows them missing). */
const RUN_BUNDLE_ARTIFACT_BUDGET = 16 * 1024 * 1024
const MAX_MESSAGES = 50_000
const MAX_EVENTS = 200_000
const MAX_ARTIFACTS = 500

const BundleEventSchema = z.object({
  at: z.string().min(1).max(64),
  event: z.object({ type: z.string().min(1).max(100) }).passthrough()
})

const BundleArtifactSchema = z.object({
  name: z.string().regex(TOOL_IMAGE_ARTIFACT_RE),
  /** Base64 bytes; checked against the image formats a tool can store. */
  data: z
    .string()
    .max(Math.ceil((MAX_TOOL_IMAGE_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
})

export const RunBundleSchema = z.object({
  format: z.literal(RUN_BUNDLE_FORMAT),
  version: z.literal(RUN_BUNDLE_VERSION),
  exportedAt: z.string().min(1),
  app: z.object({ name: z.string().max(100).optional(), version: z.string().max(100).optional() }).optional(),
  task: z.object({
    /** The id the task had where it was exported; an import never reuses it. */
    runId: z.string().min(1).max(200),
    title: z.string().max(1_000),
    goal: z.string().max(20_000),
    status: z.enum(['running', 'cancelled', 'error', 'done']),
    mode: AgentInteractionModeSchema.optional(),
    step: z.number().int().min(0).optional(),
    updatedAt: z.string().max(64).optional(),
    error: z.string().max(10_000).optional()
  }),
  contract: z.string().max(1_000_000).optional(),
  plan: z.string().max(1_000_000).optional(),
  checks: DoneWhenChecksFileSchema.optional(),
  messages: z.array(ChatMessageSchema).max(MAX_MESSAGES),
  events: z.array(BundleEventSchema).max(MAX_EVENTS),
  artifacts: z.array(BundleArtifactSchema).max(MAX_ARTIFACTS).optional()
})
export type RunBundle = z.infer<typeof RunBundleSchema>

function readTextIfPresent(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** Stored tool images, oldest name first, within the bundle's image budget. */
function collectArtifacts(runDir: string): Array<{ name: string; data: string }> {
  const out: Array<{ name: string; data: string }> = []
  let budget = RUN_BUNDLE_ARTIFACT_BUDGET
  for (const sub of ['images', 'browser']) {
    const dir = join(runDir, sub)
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const file of names) {
      const name = `${sub}/${file}`
      if (!TOOL_IMAGE_ARTIFACT_RE.test(name) || out.length >= MAX_ARTIFACTS) continue
      try {
        const st = statSync(join(dir, file))
        if (!st.isFile() || st.size > MAX_TOOL_IMAGE_BYTES || st.size > budget) continue
        const bytes = readFileSync(join(dir, file))
        if (!sniffImageFormat(bytes)) continue
        budget -= bytes.length
        out.push({ name, data: bytes.toString('base64') })
      } catch {
        // An unreadable image is left out; the record shows it missing.
      }
    }
  }
  return out
}

/** The task as a bundle — every message and event, redacted. */
export async function buildRunBundle(
  workspacePath: string,
  runId: string,
  appVersion?: string,
  now = new Date()
): Promise<RunBundle> {
  if (!runExists(workspacePath, runId)) throw new Error('Run not found')
  const runDir = resolveRunDir(workspacePath, runId)
  const status = loadStatus(runDir)
  if (!status) throw new Error('Invalid run status')
  const [messages, events] = await Promise.all([loadMessagesAsync(workspacePath, runId), loadEventsAsync(runDir, runId)])
  const goal = redactSecretsInText(status.goal?.trim() || 'chat')
  const checks = (() => {
    const raw = readTextIfPresent(join(runDir, DONE_WHEN_CHECKS_FILE))
    if (!raw) return undefined
    try {
      const parsed = DoneWhenChecksFileSchema.safeParse(JSON.parse(raw))
      return parsed.success ? redactForRecord(parsed.data) : undefined
    } catch {
      return undefined
    }
  })()
  const contract = readTextIfPresent(join(runDir, 'contract.md'))
  const plan = readTextIfPresent(join(runDir, 'plan.md'))
  const artifacts = collectArtifacts(runDir)
  return {
    format: RUN_BUNDLE_FORMAT,
    version: RUN_BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    app: { name: 'Vyotiq', ...(appVersion ? { version: appVersion } : {}) },
    task: {
      runId,
      title: taskTitleFromGoal(goal),
      goal,
      status: status.status,
      ...(status.mode ? { mode: status.mode } : {}),
      step: status.step,
      updatedAt: status.updatedAt,
      ...(status.error ? { error: redactSecretsInText(status.error) } : {})
    },
    ...(contract != null ? { contract: redactSecretsInText(contract) } : {}),
    ...(plan != null ? { plan: redactSecretsInText(plan) } : {}),
    ...(checks ? { checks } : {}),
    messages: messages.map((message) => redactForRecord(message)),
    events: events
      .filter((row): row is PersistedEvent & { event: { type: string } } => {
        const event = row.event as { type?: unknown } | null
        return event != null && typeof event === 'object' && typeof event.type === 'string'
      })
      .map((row) => ({ at: row.at, event: redactForRecord(row.event) })),
    ...(artifacts.length > 0 ? { artifacts } : {})
  }
}

/** The bundle as the file's text; refuses one past the size a bundle may have. */
export function serializeRunBundle(bundle: RunBundle): string {
  const text = `${JSON.stringify(bundle)}\n`
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > RUN_BUNDLE_MAX_BYTES) {
    throw new RunBundleError(
      `This task is too large to export as JSON (${Math.round(bytes / 1024 / 1024)} MB; the limit is ${RUN_BUNDLE_MAX_BYTES / 1024 / 1024} MB).`
    )
  }
  return text
}

/** A bundle that can't be read or written, said in words the user can act on. */
export class RunBundleError extends Error {}

/** Parse and validate a bundle's text. Throws a RunBundleError saying what is wrong. */
export function parseRunBundle(text: string): RunBundle {
  if (Buffer.byteLength(text, 'utf8') > RUN_BUNDLE_MAX_BYTES) {
    throw new RunBundleError(`The file is larger than ${RUN_BUNDLE_MAX_BYTES / 1024 / 1024} MB.`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new RunBundleError('The file is not JSON.')
  }
  const head = raw as { format?: unknown; version?: unknown } | null
  if (!head || typeof head !== 'object' || head.format !== RUN_BUNDLE_FORMAT) {
    throw new RunBundleError('The file is not a Vyotiq task export.')
  }
  if (typeof head.version === 'number' && head.version > RUN_BUNDLE_VERSION) {
    throw new RunBundleError(`The task was exported by a newer Vyotiq (format version ${head.version}). Update to import it.`)
  }
  const parsed = RunBundleSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new RunBundleError(`The task file is damaged${where}: ${issue?.message ?? 'invalid'}.`)
  }
  return parsed.data
}

/** Read a bundle file, refusing an oversized one before reading it. */
export async function readRunBundleFile(path: string): Promise<RunBundle> {
  const st = await stat(path)
  if (!st.isFile()) throw new RunBundleError('That is not a file.')
  if (st.size > RUN_BUNDLE_MAX_BYTES) {
    throw new RunBundleError(`The file is larger than ${RUN_BUNDLE_MAX_BYTES / 1024 / 1024} MB.`)
  }
  return parseRunBundle(await readFile(path, 'utf8'))
}

/** The event with the task's old id swapped for its new one; other ids (helper instances) are kept. */
function retargetEvent(event: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  return event.runId === from ? { ...event, runId: to } : event
}

/**
 * Write a bundle into the workspace as a new, finished, read-only task.
 * Never touches an existing run: the id is fresh, and a failure part way
 * removes what it wrote.
 */
export async function importRunBundle(
  workspacePath: string,
  bundle: RunBundle,
  now = new Date()
): Promise<{ runId: string; title: string }> {
  let runId = randomUUID()
  while (runExists(workspacePath, runId)) runId = randomUUID()
  const goal = bundle.task.goal.trim() || 'chat'
  const runDir = createRun(workspacePath, runId, goal, { mode: bundle.task.mode ?? 'agent' })
  try {
    // Finished before anything else lands: a run left "running" and inactive
    // would read as interrupted and be offered for resume.
    await updateStatus(
      runDir,
      {
        status: 'done',
        step: bundle.task.step ?? 0,
        imported: {
          at: now.toISOString(),
          sourceRunId: bundle.task.runId,
          exportedAt: bundle.exportedAt
        }
      },
      { sync: true }
    )
    if (bundle.contract != null) atomicWriteFile(join(runDir, 'contract.md'), redactSecretsInText(bundle.contract))
    if (bundle.plan != null) atomicWriteFile(join(runDir, 'plan.md'), redactSecretsInText(bundle.plan))
    if (bundle.checks) atomicWriteJson(join(runDir, DONE_WHEN_CHECKS_FILE), redactForRecord(bundle.checks))
    await syncMessagesAsync(runDir, bundle.messages as ChatMessage[])
    await syncEventsAsync(
      runDir,
      bundle.events.map((row) => ({ at: row.at, event: retargetEvent(row.event, bundle.task.runId, runId) }))
    )
    for (const artifact of bundle.artifacts ?? []) {
      const bytes = Buffer.from(artifact.data, 'base64')
      // Only an image a tool could have stored: the name says where, the bytes say what.
      if (bytes.length === 0 || bytes.length > MAX_TOOL_IMAGE_BYTES || !sniffImageFormat(bytes)) continue
      const target = join(runDir, artifact.name)
      mkdirSync(dirname(target), { recursive: true })
      atomicWriteBuffer(target, bytes)
    }
  } catch (err) {
    rmSync(runDir, { recursive: true, force: true })
    invalidateListRunsCache(workspacePath)
    throw err
  }
  invalidateListRunsCache(workspacePath)
  return { runId, title: taskTitleFromGoal(goal) }
}

/** A task read in from a bundle: its record is final, and a new instruction is refused. */
export function isImportedRun(workspacePath: string, runId: string): boolean {
  try {
    return loadStatus(resolveRunDir(workspacePath, runId))?.imported != null
  } catch {
    return false
  }
}
