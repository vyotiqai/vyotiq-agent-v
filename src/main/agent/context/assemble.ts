import type { ChatMessage, ModelInfo, ProviderId } from '../../../shared/ipc'
import { contentToText, flattenFileParts } from '../../../shared/ipc'
import type { LlmProvider } from '../providers/types'
import { anthropicNativeOptions } from './anthropicContext'
import { allocateBudget, contentWindow, contextWindowFor } from './budget'
import { proactiveCompactThresholdTokens, remainingContentTokens } from '../../../shared/domain/contextBudget'
import {
  estimateMessagesTokensAsync,
  estimateTextTokens,
  estimateTextTokensAsync
} from './estimate'
import { stubPastSkillInvocationsInMessages } from '../../../shared/slashCommands'
import {
  KEEP_LAST_TOOL_RESULTS,
  KEEP_RECENT_TURNS,
  type AssembleInput,
  type AssembleResult,
  type CompactionRecord,
  type ContextLayerBreakdown
} from './types'
import { formatPinnedFacts } from './pinFoldFacts'
import { stripUnsupportedModalitiesFromMessages, wireCapsFromModel } from './stripImages'
import { trimToolResults } from './toolTrim'
import { buildWorkspaceRulesSection } from './rules'
import { formatResponseStyle, formatUserRules } from './userRules'
import { readMemoryIndexAsync, readMemoryStateAsync } from './memory'
import { buildWorkspaceSnapshotAsync } from './workspaceSnapshot'
import { perfLog, perfNow } from './perfDebug'
import { logger } from '../../../shared/logger'
import { splitHarnessSections } from '../harnessSections'
import { formatPromptSection, parseOuterPromptSection, wrapPromptSection } from '../promptSections'

/** Full request for `assembleContext` (AssembleInput + provider/stream fields). */
export type AssembleContextRequest = AssembleInput & {
  providerId: ProviderId
  provider: LlmProvider
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  /**
   * Workspace to read durable memory (state.md + index.md) from. Defaults to
   * workspacePath. Worktree instances pass the parent workspace here because a
   * sparse instance checkout has no .vyotiq; snapshot and rules stay worktree-local.
   */
  memoryWorkspacePath?: string | null
}

/** In-process cache for the stable instruction prefix only (not the volatile tail). */
type SystemCacheEntry = { fingerprint: string; stable: string }
let systemPromptCache: SystemCacheEntry | null = null

/** @internal — clear stable system-prefix cache (tests). */
export function clearSystemPromptCache(): void {
  systemPromptCache = null
}

/**
 * Fingerprint of durable instruction layers only. Volatile data (clock, snapshot,
 * loop hints) must not appear here or the cache never hits across steps.
 * Compaction summary is session-stable until the next fold and must be included
 * so a new fold busts the in-process prefix cache.
 */
function stableSystemFingerprint(parts: {
  harness: string
  userRules: string
  responseStyleSection: string
  rules: string
  skillsSection: string
  pluginRulesSection: string
  contract: string
  plan: string
  modeSection?: string
  memorySection: string
  compactionSummary: string
  compactionPinned: string
  systemBudget: number
  planVerbatim?: boolean
}): string {
  return [
    parts.harness,
    parts.userRules,
    parts.responseStyleSection,
    parts.rules,
    parts.skillsSection,
    parts.pluginRulesSection,
    parts.contract,
    parts.plan,
    parts.modeSection ?? '',
    parts.memorySection,
    parts.compactionSummary,
    parts.compactionPinned,
    String(parts.systemBudget),
    parts.planVerbatim ? 'plan-verbatim' : 'plan-capped'
  ].join('\0')
}

function capPlainText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  const ellipsis = '\n…'
  if (maxChars <= ellipsis.length) return '…'.slice(0, maxChars)
  return text.slice(0, maxChars - ellipsis.length) + ellipsis
}

function capText(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4)
  const parsed = parseOuterPromptSection(text)
  if (!parsed) return capPlainText(text, maxChars)
  const overhead = formatPromptSection(parsed.tag, '').length
  const innerMax = Math.max(0, maxChars - overhead)
  if (parsed.inner.length <= innerMax) return formatPromptSection(parsed.tag, parsed.inner)
  return formatPromptSection(parsed.tag, capPlainText(parsed.inner, innerMax))
}

/** @internal — token cap that keeps a single overlay wrap paired. */
export function capToTokenBudget(text: string, maxTokens: number, model: ModelInfo): string {
  const parsed = parseOuterPromptSection(text)
  if (parsed) {
    let inner = parseOuterPromptSection(capText(text, maxTokens))?.inner ?? parsed.inner
    let out = formatPromptSection(parsed.tag, inner)
    while (out.length > 200 && estimateTextTokens(out, model) > maxTokens) {
      if (inner.length === 0) break
      inner = inner.slice(0, Math.max(0, Math.floor(inner.length * 0.8)))
      out = formatPromptSection(parsed.tag, inner)
    }
    return out
  }
  let out = capText(text, maxTokens)
  while (out.length > 200 && estimateTextTokens(out, model) > maxTokens) {
    const next = out.slice(0, Math.floor(out.length * 0.8))
    if (next === out) break
    out = next
  }
  return out
}

function harnessSectionPriority(heading: string, fromAppendix: boolean): number {
  const h = heading.toLowerCase().replace(/_/g, ' ')
  // Workspace appendix must never outrank first-party Constraints / Tool policy.
  const spineCap = fromAppendix ? 49 : 100
  let priority = 20
  if (h.includes('role')) priority = 100
  else if (h.includes('tool')) priority = 99
  else if (h.includes('constraints')) priority = 98
  else if (h.includes('output format') || h.includes('patterns')) priority = 97
  else if (h.includes('capabilities')) priority = 96
  else if (h.includes('work style') || h.includes('workstyle')) priority = 95
  else if (h.includes('scope boundaries')) priority = 94
  else if (h.includes('compaction')) priority = 90
  else if (h.includes('reference points')) priority = 72
  else if (h.includes('aliases')) priority = 58
  else if (h.includes('memory')) priority = 50
  else if (h.includes('examples')) priority = 42
  else if (h.includes('workspace harness')) priority = 30
  return Math.min(priority, spineCap)
}

function isAppendixSectionName(name: string): boolean {
  const h = name.toLowerCase().replace(/_/g, ' ')
  return h === 'workspace harness' || h === 'untrusted content'
}

/** @internal — section-aware harness trim under system-budget pressure (tests). */
export function capHarness(text: string, maxTokens: number): string {
  const maxChars = Math.max(200, maxTokens * 4)
  if (text.length <= maxChars) return text

  const chunks = splitHarnessSections(text)
  if (chunks.length <= 1) return capText(text, maxTokens)

  // Everything from the workspace-harness / appendix marker onward is untrusted.
  let inAppendix = false
  type Sec = { text: string; priority: number; keep: boolean }
  const sections: Sec[] = chunks.map((chunk) => {
    if (isAppendixSectionName(chunk.name)) inAppendix = true
    const fromAppendix = inAppendix
    const priority = chunk.name
      ? harnessSectionPriority(chunk.name, fromAppendix)
      : fromAppendix
        ? 40
        : 95
    return { text: chunk.text, priority, keep: true }
  })

  const joined = (): string =>
    sections
      .filter((s) => s.keep)
      .map((s) => s.text)
      .join('\n\n')
      .trimEnd()

  let out = joined()
  if (out.length <= maxChars) return out

  const dropOrder = [...sections.keys()].sort(
    (a, b) => sections[a]!.priority - sections[b]!.priority
  )
  for (const idx of dropOrder) {
    if (sections[idx]!.priority >= 95) continue
    sections[idx]!.keep = false
    out = joined()
    if (out.length <= maxChars) return out
  }

  const shrinkOrder = [...sections.keys()]
    .filter((i) => sections[i]!.keep)
    .sort((a, b) => sections[a]!.priority - sections[b]!.priority)

  const shrinkSection = (idx: number): boolean => {
    const sec = sections[idx]!
    const parsed = parseOuterPromptSection(sec.text)
    if (parsed) {
      if (parsed.inner.length === 0) return false
      const nextInner = parsed.inner.slice(0, Math.max(0, Math.floor(parsed.inner.length * 0.8)))
      sec.text = formatPromptSection(parsed.tag, nextInner === parsed.inner ? '' : nextInner)
      return true
    }
    if (sec.text.length === 0) return false
    const next = sec.text.slice(0, Math.max(0, Math.floor(sec.text.length * 0.8)))
    if (next === sec.text) {
      sec.text = ''
      return true
    }
    sec.text = next
    return true
  }

  for (const idx of shrinkOrder) {
    out = joined()
    const overflow = out.length - maxChars
    if (overflow <= 0) return out
    const sec = sections[idx]!
    const parsed = parseOuterPromptSection(sec.text)
    if (parsed) {
      const innerMax = Math.max(0, parsed.inner.length - overflow)
      sec.text = formatPromptSection(parsed.tag, capPlainText(parsed.inner, innerMax))
      continue
    }
    sec.text = capPlainText(sec.text, Math.max(0, sec.text.length - overflow))
  }

  while (joined().length > maxChars) {
    const idx = shrinkOrder.find((i) => {
      const parsed = parseOuterPromptSection(sections[i]!.text)
      return parsed ? parsed.inner.length > 0 : sections[i]!.text.length > 0
    })
    if (idx === undefined || !shrinkSection(idx)) break
  }

  out = joined()
  return out || capText(text, maxTokens)
}

function buildStableSystem(parts: {
  harness: string
  userRules: string
  responseStyleSection?: string
  rules: string
  skillsSection?: string
  pluginRulesSection?: string
  contract?: string
  plan?: string
  modeSection?: string
  planVerbatim?: boolean
  memorySection?: string
  compaction?: CompactionRecord | null
  budgets: ReturnType<typeof allocateBudget>
  model: ModelInfo
}): string {
  const fingerprint = stableSystemFingerprint({
    harness: parts.harness,
    userRules: parts.userRules,
    responseStyleSection: parts.responseStyleSection ?? '',
    rules: parts.rules,
    skillsSection: parts.skillsSection ?? '',
    pluginRulesSection: parts.pluginRulesSection ?? '',
    contract: parts.contract ?? '',
    plan: parts.plan ?? '',
    modeSection: parts.modeSection,
    memorySection: parts.memorySection ?? '',
    compactionSummary: parts.compaction?.summary ?? '',
    compactionPinned: JSON.stringify(parts.compaction?.pinnedFacts ?? null),
    systemBudget: parts.budgets.system,
    planVerbatim: parts.planVerbatim
  })
  if (systemPromptCache?.fingerprint === fingerprint) {
    return systemPromptCache.stable
  }

  const sections: string[] = []
  let systemTokensLeft = parts.budgets.system
  function capWithinSystem(
    text: string,
    requested: number,
    capFn: (text: string, maxTokens: number) => string = capText
  ): string | null {
    if (systemTokensLeft < 50) return null
    const allowed = Math.min(requested, systemTokensLeft)
    const capped = capToTokenBudget(capFn(text, allowed), allowed, parts.model)
    const used = estimateTextTokens(capped, parts.model)
    systemTokensLeft -= used
    return capped
  }

  const harness = capWithinSystem(
    parts.harness,
    Math.floor(parts.budgets.system * 0.75),
    capHarness
  )
  if (harness) sections.push(harness)

  if (parts.modeSection?.trim()) {
    const mode = capWithinSystem(
      parts.modeSection.trim(),
      Math.max(400, Math.floor(parts.budgets.system * 0.35))
    )
    if (mode) sections.push(mode)
  }

  if (parts.contract?.trim()) {
    const contractBody = parts.contract.trim().replace(/^#+\s*Run contract\s*(?:\r?\n)*/i, '')
    const contract = capWithinSystem(
      wrapPromptSection('run_contract', contractBody),
      Math.floor(parts.budgets.system * 0.4)
    )
    if (contract) sections.push(contract)
  }
  if (parts.plan?.trim()) {
    const planBody = parts.planVerbatim
      ? parts.plan.trim()
      : parts.plan.trim().replace(/^#+\s*Plan\s*(?:\r?\n)*/i, '')
    const wrapped = wrapPromptSection('plan', planBody)
    if (parts.planVerbatim) {
      // Skip token cap so Plan-mode str_replace can quote on-disk text.
      sections.push(wrapped)
      systemTokensLeft -= estimateTextTokens(wrapped, parts.model)
    } else {
      const plan = capWithinSystem(wrapped, parts.budgets.system)
      if (plan) sections.push(plan)
    }
  }

  if (parts.skillsSection?.trim()) {
    const skills = capWithinSystem(parts.skillsSection.trim(), Math.floor(parts.budgets.system * 0.35))
    if (skills) sections.push(skills)
  }
  if (parts.pluginRulesSection?.trim()) {
    const plugins = capWithinSystem(parts.pluginRulesSection.trim(), Math.floor(parts.budgets.system * 0.25))
    if (plugins) sections.push(plugins)
  }
  if (parts.userRules.trim()) {
    const userRulesRaw = parts.userRules.trim()
    const userRules = capWithinSystem(userRulesRaw, Math.floor(parts.budgets.system * 0.35))
    if (userRules) sections.push(userRules)
  }
  if (parts.responseStyleSection?.trim()) {
    const style = capWithinSystem(
      parts.responseStyleSection.trim(),
      Math.max(120, Math.floor(parts.budgets.system * 0.05))
    )
    if (style) sections.push(style)
  }
  if (parts.rules.trim()) {
    const rulesRaw = parts.rules.trim()
    const rules = capWithinSystem(rulesRaw, Math.floor(parts.budgets.system * 0.5))
    if (rules) {
      sections.push(rules)
      if (rules.length < rulesRaw.length) {
        logger.warn('Workspace rules truncated from system prompt under budget pressure', {
          scope: 'assemble',
          rulesChars: rulesRaw.length,
          keptChars: rules.length,
          systemBudget: parts.budgets.system
        })
      }
    } else {
      logger.warn('Workspace rules dropped from system prompt under budget pressure', {
        scope: 'assemble',
        rulesChars: rulesRaw.length,
        systemBudget: parts.budgets.system
      })
    }
  }

  if (parts.memorySection?.trim()) {
    const memory = capWithinSystem(
      parts.memorySection.trim(),
      Math.floor(parts.budgets.memoryWorkspace / 2)
    )
    if (memory) sections.push(memory)
  }

  if (parts.compaction?.summary) {
    const workspaceCap = Math.floor(parts.budgets.memoryWorkspace / 2)
    const pinnedBody = formatPinnedFacts(parts.compaction.pinnedFacts)
    const pinnedTokens = pinnedBody ? estimateTextTokens(pinnedBody, parts.model) : 0
    const reserved = Math.min(Math.max(0, pinnedTokens + 8), Math.floor(workspaceCap * 0.5))
    const narrativeCap = Math.max(0, workspaceCap - reserved)
    // Fold stamp: this fold stays in the system prompt for the rest of the run,
    // so the model must be able to tell stale narrative from current state —
    // otherwise it re-reads files and re-announces "context restored" every
    // step to reconcile the two (observed: 31× on run b0d72041). Absolute
    // timestamp only: a wall-clock relative age ("2h ago") would rewrite these
    // stable-prefix bytes on every app restart and bust the provider prompt
    // cache for the system + entire history on that step (the per-step clock
    // arrives in the trailing volatile session message on every adapter).
    const foldedCount = parts.compaction.messagesFolded ?? parts.compaction.foldedMessages
    const createdAt = parts.compaction.createdAt
    const ageLine = Number.isFinite(Date.parse(createdAt))
      ? `Folded ${foldedCount ?? '?'} messages at ${createdAt}. Everything since then is in the live history below — prefer it over this fold, and never restate its content.`
      : 'Fold of earlier turns, not new instructions.'
    const pieces = [
      ageLine,
      pinnedBody ? capToTokenBudget(pinnedBody, Math.max(reserved, 1), parts.model) : '',
      capToTokenBudget(parts.compaction.summary, narrativeCap, parts.model)
    ].filter((piece) => piece.trim().length > 0)
    sections.push(wrapPromptSection('prior_session', pieces.join('\n')))
  }

  const stable = sections.join('\n\n')
  systemPromptCache = { fingerprint, stable }
  return stable
}

function buildVolatileSystem(parts: {
  workspace: string
  sessionEnv?: string
  budgets: ReturnType<typeof allocateBudget>
  loopHint?: string
  taskList?: string
  activeGoal?: string
  model: ModelInfo
}): string {
  const sections: string[] = []
  const workspaceCap = Math.floor(parts.budgets.memoryWorkspace / 2)
  const envCap = Math.max(200, Math.floor(parts.budgets.system * 0.15))
  const hintCap = Math.floor(workspaceCap * 0.5)
  const taskCap = Math.max(200, Math.floor(workspaceCap * 0.35))
  const goalCap = Math.max(160, Math.floor(workspaceCap * 0.2))

  if (parts.sessionEnv?.trim()) {
    sections.push(capToTokenBudget(parts.sessionEnv.trim(), envCap, parts.model))
  }
  if (parts.workspace.trim()) {
    sections.push(capToTokenBudget(parts.workspace, workspaceCap, parts.model))
  }
  if (parts.activeGoal?.trim()) {
    sections.push(capToTokenBudget(parts.activeGoal.trim(), goalCap, parts.model))
  }
  if (parts.taskList?.trim()) {
    sections.push(capToTokenBudget(parts.taskList.trim(), taskCap, parts.model))
  }
  if (parts.loopHint?.trim()) {
    sections.push(
      wrapPromptSection(
        'run_notice',
        capToTokenBudget(parts.loopHint.trim(), hintCap, parts.model)
      )
    )
  }
  return sections.join('\n\n')
}

type SystemZones = { stable: string; volatile: string; system: string }

function buildSystemZones(parts: {
  harness: string
  workspace: string
  userRules: string
  rules: string
  skillsSection?: string
  pluginRulesSection?: string
  contract?: string
  plan?: string
  modeSection?: string
  planVerbatim?: boolean
  sessionEnv?: string
  responseStyleSection?: string
  memorySection?: string
  compaction?: CompactionRecord | null
  budgets: ReturnType<typeof allocateBudget>
  loopHint?: string
  taskList?: string
  activeGoal?: string
  model: ModelInfo
}): SystemZones {
  const stable = buildStableSystem({
    harness: parts.harness,
    userRules: parts.userRules,
    responseStyleSection: parts.responseStyleSection,
    rules: parts.rules,
    skillsSection: parts.skillsSection,
    pluginRulesSection: parts.pluginRulesSection,
    contract: parts.contract,
    plan: parts.plan,
    modeSection: parts.modeSection,
    planVerbatim: parts.planVerbatim,
    memorySection: parts.memorySection,
    compaction: parts.compaction,
    budgets: parts.budgets,
    model: parts.model
  })
  const volatile = buildVolatileSystem({
    workspace: parts.workspace,
    sessionEnv: parts.sessionEnv,
    budgets: parts.budgets,
    loopHint: parts.loopHint,
    taskList: parts.taskList,
    activeGoal: parts.activeGoal,
    model: parts.model
  })
  const system = !volatile ? stable : !stable ? volatile : `${stable}\n\n${volatile}`
  return { stable, volatile, system }
}

/**
 * Pre-load durable workspace memory (state.md + index.md) into the stable
 * zone so the <memory> continuation flow works without spending a memory_read
 * tool call on every run. Both files are char-capped by the memory readers.
 */
async function buildMemorySection(workspacePath: string | null | undefined): Promise<string> {
  if (!workspacePath) return ''
  const [state, index] = await Promise.all([
    readMemoryStateAsync(workspacePath),
    readMemoryIndexAsync(workspacePath)
  ])
  const stateBody = state.trim()
  const indexBody = index.trim()
  if (!stateBody && !indexBody) return ''
  const pieces: string[] = [
    'Durable workspace memory, pre-loaded below (memory_read fetches full note bodies):'
  ]
  if (stateBody) pieces.push(`## state.md\n\n${stateBody}`)
  if (indexBody) pieces.push(`## index.md\n\n${indexBody}`)
  return wrapPromptSection('memory', pieces.join('\n\n'))
}

async function computeLayers(
  system: string,
  messages: ChatMessage[],
  toolsJsonEstimate: number,
  model: ModelInfo
): Promise<ContextLayerBreakdown> {
  const [systemTokens, history] = await Promise.all([
    estimateTextTokensAsync(system, model),
    estimateMessagesTokensAsync(messages, model)
  ])
  const used = systemTokens + history + toolsJsonEstimate
  const budget = contentWindow(model)
  return {
    system: systemTokens,
    history,
    tools: toolsJsonEstimate,
    buffer: remainingContentTokens(budget, used)
  }
}

function totalFromLayers(layers: ContextLayerBreakdown): number {
  return layers.system + layers.history + layers.tools
}

export async function assembleContext(
  input: AssembleContextRequest
): Promise<AssembleResult> {
  const assembleStarted = perfNow()
  const budgets = allocateBudget(input.model)
  const window = contentWindow(input.model)

  const memoryWorkspacePath = input.memoryWorkspacePath ?? input.workspacePath
  const [workspace, rules, memorySection] = await Promise.all([
    buildWorkspaceSnapshotAsync(input.workspacePath, input.goal),
    buildWorkspaceRulesSection(input.workspacePath, input.focusedFile),
    buildMemorySection(memoryWorkspacePath)
  ])

  let messages = input.messages.map((message) =>
    typeof message.content === 'string'
      ? message
      : { ...message, content: flattenFileParts(message.content) }
  )
  messages = stubPastSkillInvocationsInMessages(messages).messages
  messages = stripUnsupportedModalitiesFromMessages(messages, wireCapsFromModel(input.model))
  const compaction = input.priorCompaction ?? null

  const estimateStarted = perfNow()
  const userRules = formatUserRules(input.userRules ?? [])
  const responseStyleSection = formatResponseStyle({
    persona: input.persona,
    tone: input.tone,
    responseLanguage: input.responseLanguage,
    responseVerbosity: input.responseVerbosity
  })
  const systemParts = {
    harness: input.harness,
    workspace,
    userRules,
    responseStyleSection,
    rules,
    skillsSection: input.skillsSection,
    pluginRulesSection: input.pluginRulesSection,
    contract: input.contract,
    plan: input.plan,
    modeSection: input.modeSection,
    planVerbatim: input.planVerbatim,
    sessionEnv: input.sessionEnv,
    memorySection,
    budgets,
    loopHint: input.loopHint,
    taskList: input.taskList,
    activeGoal: input.activeGoal,
    model: input.model
  }

  const zones = buildSystemZones({
    ...systemParts,
    compaction
  })

  let layers = await computeLayers(
    zones.system,
    messages,
    input.toolsJsonEstimate,
    input.model
  )
  let estimated = totalFromLayers(layers)
  // Cheap pre-compaction elision: once the assembled history itself crosses
  // the compaction trigger, clear ephemeral tool bodies beyond the keep window
  // on the request wire set (durable tools exempt; transcript keeps full
  // results). Estimate-anchored by contract — provider input above the
  // estimate must not force a trim (re-read loop regression, run ba335d72).
  // Stub is deliberately non-instructive ([cleared]).
  const wireTrimTrigger = proactiveCompactThresholdTokens(window)
  if (estimated >= wireTrimTrigger) {
    const trimmed = trimToolResults(messages, KEEP_LAST_TOOL_RESULTS)
    if (trimmed.some((m, i) => m !== messages[i])) {
      messages = trimmed
      layers = await computeLayers(zones.system, messages, input.toolsJsonEstimate, input.model)
      estimated = totalFromLayers(layers)
    }
  }
  perfLog('estimateMessagesTokens', estimateStarted, {
    messages: messages.length,
    estimated
  })

  perfLog('assembleContext', assembleStarted, {
    messages: messages.length,
    estimated
  })

  return {
    system: zones.system,
    systemStable: zones.stable,
    systemVolatile: zones.volatile,
    messages,
    compaction,
    estimatedTokens: estimated,
    layers,
    overflow: estimated > window,
    anthropicNative: anthropicNativeOptions()
  }
}

export type { AssembleResult, CompactionRecord, ChatMessage }
