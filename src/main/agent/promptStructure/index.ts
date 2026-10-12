import { createHash } from 'crypto'
import { existsSync } from 'fs'
import type { ChatMessage, ProviderIdAny, Settings } from '../../../shared/ipc'
import type {
  PromptStructureRequestSchema,
  PromptStructureResult
} from '../../../shared/ipc/schemas/promptStructure'
import type { z } from 'zod'
import { resolveEffectiveSettings } from '../../../shared/domain/effectiveSettings'
import { providerNeedsKey, resolveProviderChatBaseUrl } from '../../../shared/domain/providers'
import { estimateStepCost } from '../../../shared/pricing/modelPrices'
import { logger } from '../../../shared/logger'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '../../workspace/workspaces'
import { getSettings } from '../../settings/settings'
import { getSecret } from '../../settings/secrets'
import { resolveRunDir, workspaceUsageDir } from '../../storage/paths'
import { getProvider } from '../providers'
import type { TokenUsage } from '../providers/types'
import { usableUtilityModel } from '../sideModels'
import { recordAuxUsage } from '../usageLedger'
import { resolveRunModelPrice } from '../pricing'
import { gatherStructureContext, type StructureContext } from './context'
import { STRUCTURE_SYSTEM, buildStructureMessage, correctionMessage } from './instructions'
import { ensureTokens, parseStructureReply, type ParsedStructure } from './parse'
import { findUnknownReferences, markNotFound } from './verify'

type Request = z.output<typeof PromptStructureRequestSchema>

/** Bumped when the instructions change, so a brief written by the old ones is not reused. */
const PROMPT_VERSION = 'v1'
/** A long brief, with room for a model that thinks a little first. */
const MAX_OUTPUT_TOKENS = 3_000
/**
 * A stream that goes quiet this long is stuck. A long brief streaming
 * steadily is not: ~3k tokens at ~20ms each is a minute, so the whole
 * attempt gets the longer cap below. A retry gets its own of both.
 */
const IDLE_TIMEOUT_MS = 30_000
const ATTEMPT_TIMEOUT_MS = 120_000
const CACHE_MAX = 24
const CACHE_TTL_MS = 15 * 60_000

type Cached = { result: PromptStructureResult; at: number }
const cache = new Map<string, Cached>()
/** In-flight calls by the renderer's request id, so Esc can stop one. */
const inflight = new Map<string, AbortController>()

export function cancelPromptStructure(requestId: string): boolean {
  const controller = inflight.get(requestId)
  if (!controller) return false
  controller.abort()
  return true
}

function remember(key: string, result: PromptStructureResult): void {
  cache.delete(key)
  cache.set(key, { result, at: Date.now() })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function recall(key: string): PromptStructureResult | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.result
}

export function clearPromptStructureCacheForTests(): void {
  cache.clear()
}

function unavailable(reason: string, detail?: string): PromptStructureResult {
  logger.warn(`Prompt structure unavailable: ${reason}${detail ? ` (${detail})` : ''}`, {
    scope: 'agent',
    code: 'PROMPT_STRUCTURE_FALLBACK'
  })
  return { kind: 'unavailable', reason }
}

type Model = { provider: ProviderIdAny; model: string; apiKey: string | null; baseUrl: string | undefined; settings: Settings }

/**
 * The utility model when one is set and usable — a rewrite is a side call —
 * else the model the composer has picked, else the workspace's.
 */
function resolveModel(req: Request): Model | { error: string } {
  let settings: Settings
  try {
    const global = getSettings()
    const override = findWorkspaceSettingsOverride(readWorkspacesState(), req.workspacePath)
    settings = { ...global, ...resolveEffectiveSettings(global, override) }
  } catch {
    return { error: 'Could not read agent settings' }
  }
  const utility = usableUtilityModel(settings)
  if (utility) return { ...utility, settings }
  const provider = (req.provider ?? settings.provider) as ProviderIdAny
  const model = req.model ?? settings.model
  if (!model) return { error: 'No model is selected' }
  try {
    const apiKey = getSecret(provider)
    const baseUrl = resolveProviderChatBaseUrl(provider, settings, apiKey)
    if (providerNeedsKey(provider, baseUrl ?? settings.ollamaBaseUrl) && !apiKey?.trim()) {
      return { error: `No API key configured for ${provider}` }
    }
    return { provider, model, apiKey, baseUrl, settings }
  } catch {
    return { error: 'Could not resolve the provider endpoint' }
  }
}

/** The task whose instruction this is carries the cost; else the workspace's own ledger. */
function usageDirFor(workspacePath: string, runId: string | undefined): string {
  if (runId) {
    try {
      const dir = resolveRunDir(workspacePath, runId)
      if (existsSync(dir)) return dir
    } catch {
      // An id that is not a run of this workspace: no task to bill.
    }
  }
  return workspaceUsageDir(workspacePath)
}

async function recordUsage(req: Request, model: Model, usage: TokenUsage): Promise<void> {
  try {
    const price = usage.billedCost == null ? await resolveRunModelPrice(model.provider, model.model, model.baseUrl) : null
    const estimated = price ? (estimateStepCost(usage, price) ?? undefined) : undefined
    recordAuxUsage(usageDirFor(req.workspacePath, req.runId), {
      site: 'prompt_structure',
      ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens != null ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.reasoningTokens != null ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.billedCost != null ? { billedCost: usage.billedCost } : {}),
      ...(estimated !== undefined ? { estimatedCost: estimated } : {})
    })
  } catch (err) {
    logger.warn('Could not record the prompt structure spend', { scope: 'agent', err })
  }
}

type Attempt = { raw: string } | { error: 'cancelled' | 'timeout' | 'unreachable' | 'model_error' }

async function callModel(req: Request, model: Model, messages: ChatMessage[], cancel: AbortSignal): Promise<Attempt> {
  const controller = new AbortController()
  let timedOut = false
  const expire = (): void => {
    timedOut = true
    controller.abort()
  }
  const timer = setTimeout(expire, ATTEMPT_TIMEOUT_MS)
  let idle = setTimeout(expire, IDLE_TIMEOUT_MS)
  const onCancel = (): void => controller.abort()
  cancel.addEventListener('abort', onCancel)
  const startedAt = Date.now()
  let raw = ''
  try {
    const provider = getProvider(model.provider)
    for await (const chunk of provider.streamChat({
      model: model.model,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      signal: controller.signal,
      tools: [],
      system: STRUCTURE_SYSTEM,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinking: { enabled: false }
    })) {
      if (controller.signal.aborted) break
      // Any chunk — thinking included — says the stream is alive.
      clearTimeout(idle)
      idle = setTimeout(expire, IDLE_TIMEOUT_MS)
      if (chunk.type === 'done' && chunk.usage) {
        await recordUsage(req, model, chunk.usage)
        logger.info('Token cost aux call', {
          scope: 'agent',
          code: 'AUX_USAGE',
          site: 'prompt_structure',
          provider: model.provider,
          model: model.model,
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          cachedInputTokens: chunk.usage.cachedInputTokens,
          generationMs: Math.max(0, Date.now() - startedAt)
        })
      }
      if (chunk.type === 'text' && chunk.text) raw += chunk.text
      if (chunk.type === 'error') return { error: 'model_error' }
    }
  } catch {
    if (cancel.aborted) return { error: 'cancelled' }
    return { error: timedOut ? 'timeout' : 'unreachable' }
  } finally {
    clearTimeout(timer)
    clearTimeout(idle)
    cancel.removeEventListener('abort', onCancel)
  }
  if (cancel.aborted) return { error: 'cancelled' }
  if (timedOut) return { error: 'timeout' }
  return { raw }
}

const ATTEMPT_REASON: Record<Exclude<Attempt, { raw: string }>['error'], string> = {
  cancelled: 'Cancelled',
  timeout: 'The model took too long',
  unreachable: 'Could not reach the model',
  model_error: 'The model returned an error'
}

function cacheKey(req: Request, model: Model): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        PROMPT_VERSION,
        req.workspacePath,
        req.runId ?? '',
        req.mode ?? 'agent',
        req.text,
        req.mentions,
        req.answers ?? [],
        req.noQuestions === true,
        model.provider,
        model.model
      ])
    )
    .digest('hex')
}

/** The brief as the person gets it: every chip in place, anything not found marked. */
function finishBrief(
  parsed: Extract<ParsedStructure, { kind: 'brief' }>,
  req: Request,
  context: StructureContext
): { brief: string; notFound: string[] } {
  const tokens = req.mentions.map((m) => m.token)
  const brief = ensureTokens(parsed.brief, tokens)
  const notFound = findUnknownReferences({
    brief,
    known: context.known,
    workspacePath: req.workspacePath,
    instruction: req.text,
    mentionPaths: req.mentions.map((m) => m.path).filter((p): p is string => Boolean(p))
  })
  return { brief, notFound }
}

/**
 * Rewrite one instruction as a brief, or ask what it needs first. Never
 * throws: a failure is `unavailable` with the reason, and the draft stays.
 */
export async function structurePrompt(req: Request): Promise<PromptStructureResult> {
  const model = resolveModel(req)
  if ('error' in model) return unavailable(model.error)
  const key = cacheKey(req, model)
  if (!req.force) {
    const hit = recall(key)
    if (hit) return hit.kind === 'brief' ? { ...hit, reused: true } : hit
  }

  const cancel = new AbortController()
  inflight.get(req.requestId)?.abort()
  inflight.set(req.requestId, cancel)
  try {
    const context = await gatherStructureContext({
      workspacePath: req.workspacePath,
      text: req.text,
      mentions: req.mentions,
      ...(req.runId ? { runId: req.runId } : {})
    })
    if (cancel.signal.aborted) return { kind: 'cancelled' }
    const answered = (req.answers?.length ?? 0) > 0
    const first = buildStructureMessage({
      text: req.text,
      mentions: req.mentions,
      mode: req.mode === 'ask' ? 'ask' : 'agent',
      ...(req.answers ? { answers: req.answers } : {}),
      noQuestions: req.noQuestions === true || answered,
      context
    })
    const messages: ChatMessage[] = [first]
    let parsed: ParsedStructure | null = null
    let finished: { brief: string; notFound: string[] } | null = null
    let lastRaw = ''
    // One try, and one more with a note on what was wrong with the first.
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await callModel(req, model, messages, cancel.signal)
      if ('error' in reply) {
        if (reply.error === 'cancelled') return { kind: 'cancelled' }
        return unavailable(ATTEMPT_REASON[reply.error])
      }
      lastRaw = reply.raw
      const next = parseStructureReply(reply.raw)
      // Questions after answers (or after Skip) are not what was asked for.
      // So is anything but a brief from the retry that was correcting one: the first brief stands.
      const wrongKind = next?.kind === 'questions' && (answered || req.noQuestions === true || finished != null)
      if (!next || wrongKind) {
        if (attempt === 1) break
        messages.push({ role: 'assistant', content: reply.raw || '(empty)' })
        messages.push(wrongKind
          ? { role: 'user', content: 'Write the brief now, as the JSON object with "kind":"brief". Do not ask questions.' }
          : correctionMessage({ invalid: true }))
        continue
      }
      parsed = next
      if (next.kind === 'questions') break
      finished = finishBrief(next, req, context)
      if (finished.notFound.length === 0 || attempt === 1) break
      messages.push({ role: 'assistant', content: reply.raw })
      messages.push(correctionMessage({ notFound: finished.notFound }))
    }
    if (!parsed) {
      // What it sent instead, in the log only: the shape is what to fix, so a little of it is enough.
      const shape = lastRaw.replace(/\s+/g, ' ').trim().slice(0, 240) || '(no text)'
      return unavailable('The model did not return a usable brief', `${model.provider}/${model.model}: ${shape}`)
    }

    let result: PromptStructureResult
    if (parsed.kind === 'questions') {
      result = { kind: 'questions', taskType: parsed.taskType, questions: parsed.questions }
    } else {
      const done = finished ?? finishBrief(parsed, req, context)
      result = {
        kind: 'brief',
        taskType: parsed.taskType,
        brief: done.notFound.length ? markNotFound(done.brief, done.notFound) : done.brief,
        ...(done.notFound.length ? { notFound: done.notFound } : {})
      }
    }
    remember(key, result)
    return result
  } catch (err) {
    logger.warn('Prompt structure failed', { scope: 'agent', err })
    return unavailable('Something went wrong while writing the brief')
  } finally {
    if (inflight.get(req.requestId) === cancel) inflight.delete(req.requestId)
  }
}
