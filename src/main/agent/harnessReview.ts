import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { HarnessReviewResult, RunReceipt } from '../../shared/ipc'
import { RUN_RECEIPT_VERSION, RunReceiptSchema } from '../../shared/ipc'
import { resolveInsideWorkspace } from '../workspace/safePath'
import { resolveRunDir, workspaceSessionsRoot } from '../storage/paths'
import { RUN_RECEIPT_FILENAME } from './runReceipt'
import {
  predictionArtifactExists,
  trajectoryArtifactExists
} from './runTrajectory'
import {
  HARNESS_APPLY_SURFACE_NOTE,
  HARNESS_EVAL_TESTS,
  workspaceHasEditableHarness
} from './harnessApply'
import { workspaceHarnessPath, HARNESS_PROPOSALS_REL } from './harness'

const DEFAULT_LIMIT = 20

/** Evidence-bucket tags for harness review proposals (heuristic; no auto-merge). */
export const HARNESS_EVIDENCE_BUCKETS = [
  'system_prompt',
  'tool_policy',
  'loop_notices',
  'memory'
] as const

export type HarnessEvidenceBucket = (typeof HARNESS_EVIDENCE_BUCKETS)[number]

export type CollectedReceipt = {
  runId: string
  receipt: RunReceipt
}

export type EvidenceBucketEvidence = {
  component: HarnessEvidenceBucket
  evidence: string[]
}

export type WeaknessSummary = {
  receiptCount: number
  bullets: string[]
  suggestions: string[]
  evidenceBuckets: EvidenceBucketEvidence[]
}

function addRunSource(map: Map<string, Set<string>>, key: string, runId: string): void {
  const runs = map.get(key) ?? new Set<string>()
  runs.add(runId)
  map.set(key, runs)
}

function formatRunSources(runs: Iterable<string>, cap = 5): string {
  const ids = [...new Set(runs)].sort()
  const shown = ids.slice(0, cap).map((id) => `\`${id}\``)
  const more = ids.length > cap ? `, +${ids.length - cap} more` : ''
  return shown.length > 0 ? `; runs: ${shown.join(', ')}${more}` : ''
}

export function migrateLegacyReceipt(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const receipt = raw as Record<string, unknown>
  const version = receipt.version
  if (version !== 2 && version !== 3 && version !== 4) return raw

  const diagnostics =
    receipt.diagnostics && typeof receipt.diagnostics === 'object' && !Array.isArray(receipt.diagnostics)
      ? (receipt.diagnostics as Record<string, unknown>)
      : {}
  const clean =
    typeof diagnostics.clean === 'number' && Number.isInteger(diagnostics.clean) && diagnostics.clean >= 0
      ? diagnostics.clean
      : 0

  const {
    verifyBeforeDone: _verifyBeforeDone,
    contractDoneWhen: _contractDoneWhen,
    ...rest
  } = receipt

  return {
    ...rest,
    version: RUN_RECEIPT_VERSION,
    diagnostics: {
      calls: diagnostics.calls,
      ok: diagnostics.ok,
      clean
    }
  }
}

/** Load recent receipt.json files from the workspace session store (AppData). */
export function collectRecentReceipts(
  workspacePath: string,
  opts?: { limit?: number }
): CollectedReceipt[] {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? DEFAULT_LIMIT))
  const root = workspaceSessionsRoot(workspacePath)
  if (!existsSync(root)) return []

  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const collected: Array<CollectedReceipt & { writtenAt: string }> = []
  for (const runId of dirs) {
    const receiptPath = join(root, runId, RUN_RECEIPT_FILENAME)
    if (!existsSync(receiptPath)) continue
    try {
      const raw: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'))
      const parsed = RunReceiptSchema.safeParse(migrateLegacyReceipt(raw))
      if (!parsed.success) continue
      collected.push({
        runId,
        receipt: parsed.data,
        writtenAt: parsed.data.writtenAt
      })
    } catch {
      // skip corrupt receipts
    }
  }

  collected.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt))
  return collected.slice(0, limit).map(({ runId, receipt }) => ({ runId, receipt }))
}

function pushBucket(
  map: Map<HarnessEvidenceBucket, string[]>,
  component: HarnessEvidenceBucket,
  line: string
): void {
  const list = map.get(component) ?? []
  if (!list.includes(line)) list.push(line)
  map.set(component, list)
}

/** Rule-based weakness extraction from receipts (no LLM). */
export function summarizeWeaknesses(
  receipts: readonly CollectedReceipt[]
): WeaknessSummary {
  const failureCounts = new Map<string, number>()
  const failureRuns = new Map<string, Set<string>>()
  const unreadCounts = new Map<string, number>()
  const unreadRuns = new Map<string, Set<string>>()
  const highFailureRuns = new Set<string>()
  const compactionHeavyRuns = new Set<string>()
  let highFailureStreaks = 0
  let toolFailTotal = 0
  let toolCallTotal = 0
  let compactionHeavy = 0
  let memoryToolFails = 0
  let verificationStale = 0
  let diagCalls = 0
  let diagClean = 0
  let testsOk = 0
  let testsCalls = 0
  let lastPassed: number | undefined
  let lastFailed: number | undefined

  for (const { runId, receipt } of receipts) {
    toolCallTotal += receipt.toolStats.totalCalls
    toolFailTotal += receipt.toolStats.failed
    if ((receipt.maxConsecutiveToolFailures ?? 0) >= 3) {
      highFailureStreaks++
      highFailureRuns.add(runId)
    }
    if (receipt.verification && receipt.verification.verifiedAfterLastMutation === false) {
      verificationStale++
    }
    diagCalls += receipt.diagnostics?.calls ?? 0
    diagClean += receipt.diagnostics?.clean ?? 0
    if (receipt.tests) {
      testsCalls += receipt.tests.calls
      testsOk += receipt.tests.ok
      if (receipt.tests.lastPassed != null) lastPassed = receipt.tests.lastPassed
      if (receipt.tests.lastFailed != null) lastFailed = receipt.tests.lastFailed
    }
    for (const cluster of receipt.failureClusters) {
      failureCounts.set(cluster.key, (failureCounts.get(cluster.key) ?? 0) + cluster.count)
      addRunSource(failureRuns, cluster.key, runId)
      if (/^memory_/i.test(cluster.key) || /\bmemory_/i.test(cluster.key)) {
        memoryToolFails += cluster.count
      }
    }
    for (const path of receipt.unreadEditPaths) {
      unreadCounts.set(path, (unreadCounts.get(path) ?? 0) + 1)
      addRunSource(unreadRuns, path, runId)
    }
    if (receipt.compactionCount >= 2) {
      compactionHeavy++
      compactionHeavyRuns.add(runId)
    }
  }

  const bullets: string[] = []
  bullets.push(`Mined ${receipts.length} run receipt(s).`)
  if (receipts.length > 0) {
    bullets.push(
      `Receipt sources${formatRunSources(
        receipts.map(({ runId }) => runId),
        10
      )}; artifact: \`receipt.json\`.`
    )
  }
  if (toolCallTotal > 0) {
    bullets.push(
      `Tool outcomes: ${toolFailTotal}/${toolCallTotal} failed (${Math.round((toolFailTotal / toolCallTotal) * 100)}%).`
    )
  }
  const topFailures = [...failureCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
  for (const [key, count] of topFailures) {
    bullets.push(
      `Recurring failure (${count}×${formatRunSources(failureRuns.get(key) ?? [])}): ${key}`
    )
  }
  const topUnread = [...unreadCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
  for (const [path, count] of topUnread) {
    bullets.push(
      `Unread-before-edit (${count}×${formatRunSources(unreadRuns.get(path) ?? [])}): ${path}`
    )
  }
  if (highFailureStreaks > 0) {
    bullets.push(
      `${highFailureStreaks} run(s) had consecutive tool-failure streaks ≥ 3${formatRunSources(highFailureRuns)}.`
    )
  }
  if (compactionHeavy > 0) {
    bullets.push(
      `${compactionHeavy} run(s) compacted ≥ 2 times (context pressure)${formatRunSources(compactionHeavyRuns)}.`
    )
  }
  if (diagCalls > 0) {
    bullets.push(`Diagnostics: ${diagClean}/${diagCalls} clean across sampled runs.`)
  }
  if (testsCalls > 0) {
    const lastBit =
      lastPassed != null ? `; latest run: ${lastPassed} passed, ${lastFailed ?? 0} failed` : ''
    bullets.push(`run_tests: ${testsOk}/${testsCalls} exited clean${lastBit}.`)
  }
  if (verificationStale > 0) {
    bullets.push(
      `${verificationStale} run(s) ended with file mutations after the last successful check (unverified).`
    )
  }
  if (bullets.length === 1) {
    bullets.push('No strong weakness signals in the sampled receipts.')
  }

  const bucketMap = new Map<HarnessEvidenceBucket, string[]>()
  if (topUnread.length > 0) {
    pushBucket(
      bucketMap,
      'loop_notices',
      `Unread-before-edit paths (${topUnread.length} distinct) observed across receipts.`
    )
  }
  if (topFailures.length > 0 || highFailureStreaks > 0) {
    const top = topFailures[0]
    pushBucket(
      bucketMap,
      'tool_policy',
      top
        ? `Top failure cluster: ${top[0]} (${top[1]}×).`
        : `${highFailureStreaks} high consecutive-failure streak(s).`
    )
  }
  if (compactionHeavy > 0 || memoryToolFails > 0) {
    pushBucket(
      bucketMap,
      'memory',
      compactionHeavy > 0
        ? `${compactionHeavy} compaction-heavy run(s).`
        : `Memory tool failure clusters (${memoryToolFails}×).`
    )
  }
  if (verificationStale > 0) {
    pushBucket(
      bucketMap,
      'tool_policy',
      `${verificationStale} run(s) ended with file mutations after the last successful diagnostics/run_tests check.`
    )
  }

  const evidenceBuckets: EvidenceBucketEvidence[] = HARNESS_EVIDENCE_BUCKETS.filter((c) =>
    bucketMap.has(c)
  ).map((component) => ({
    component,
    evidence: bucketMap.get(component) ?? []
  }))

  // Suggestions come only from harness-owned (system prompt) evidence; tool,
  // loop, and memory signals route to their runtime owners via the fallback.
  const suggestions: string[] = []
  for (const bucket of evidenceBuckets.filter((item) => item.component === 'system_prompt')) {
    const first = bucket.evidence[0]
    if (first) suggestions.push(`- ${bucket.component}: ${first}`)
  }
  if (suggestions.length === 0) {
    suggestions.push(
      '- No harness-owned weakness found; route tool, loop, and memory signals to their runtime owners.'
    )
  }

  return {
    receiptCount: receipts.length,
    bullets,
    suggestions,
    evidenceBuckets
  }
}

export function buildProposalMarkdown(
  workspacePath: string,
  summary: WeaknessSummary,
  opts?: { proposedBody?: string }
): string {
  let proposedBody: string
  if (opts?.proposedBody?.trim()) {
    proposedBody = opts.proposedBody.trim()
  } else if (workspaceHasEditableHarness(workspacePath)) {
    // Keep the current spine as the proposed body. Receipt findings belong in
    // Evidence / Suggested harness edits — appending `## Receipt review notes`
    // fails validateHarnessMarkdown and the apply-gate toolsSchema tests.
    proposedBody = readFileSync(workspaceHarnessPath(workspacePath), 'utf8')
  } else {
    proposedBody = [
      '# Agent V',
      '',
      '_Workspace has no resources/harness/default.md — paste a full harness here before `/harness-apply`._',
      ''
    ].join('\n')
  }

  const componentLines =
    summary.evidenceBuckets.length === 0
      ? ['- (none — no strong evidence-bucket signals)']
      : summary.evidenceBuckets.flatMap((b) => [
          `- **${b.component}**`,
          ...b.evidence.map((e) => `  - ${e}`)
        ])

  const evalList = HARNESS_EVAL_TESTS.map((f) => `- \`${f}\``).join('\n')
  const disclaimer =
    '_Heuristic receipt mining + human confirm — not unsupervised Self-Harness._'

  const canApply = workspaceHasEditableHarness(workspacePath)
  const howToApply = canApply
    ? [
        '## How to apply',
        '',
        '1. Edit the proposed body above if needed.',
        '2. Run `/harness-apply` and confirm.',
        '3. Apply writes only `resources/harness/default.md`, then runs the fixed vitest subset (incl. held-out eval).',
        '4. On gate failure the file is reverted from backup.',
        ''
      ]
    : [
        '## How to apply',
        '',
        '_This workspace has no editable `resources/harness/default.md`._',
        'Open the Agent V repo (or a fork) to use `/harness-apply`, or copy the proposed body into your harness manually.',
        ''
      ]

  return [
    '# Harness proposal (auto-generated)',
    '',
    disclaimer,
    '',
    `Generated from ${summary.receiptCount} receipt(s). Review the proposed body${canApply ? ', then run `/harness-apply` (confirm + vitest gate)' : ' (apply is unavailable in this workspace)'}.`,
    '',
    '## Evidence',
    '',
    ...summary.bullets.map((b) => `- ${b}`),
    '',
    '## Evidence buckets',
    '',
    '_Maps receipt signals to editable surfaces. Still human-applied; no auto-merge._',
    '',
    ...componentLines,
    '',
    '## Suggested harness edits',
    '',
    ...summary.suggestions,
    '',
    '## Proposed harness body',
    '',
    '```markdown',
    proposedBody.replace(/\n$/, ''),
    '```',
    '',
    '## Validation',
    '',
    HARNESS_APPLY_SURFACE_NOTE,
    '',
    'Gate tests (`pnpm exec vitest run`):',
    evalList,
    '',
    'Held-out experiment: frozen grader in `harnessHeldOutEval.ts` (receipt → bucket / prediction fixtures). Runs inside the vitest gate; **never** auto-applies harness text.',
    '',
    ...howToApply
  ].join('\n')
}

export function writeHarnessProposal(
  workspacePath: string,
  summary: WeaknessSummary,
  opts?: { proposedBody?: string }
): { proposalPath: string; relativePath: string } {
  const dirAbs = resolveInsideWorkspace(workspacePath, HARNESS_PROPOSALS_REL)
  mkdirSync(dirAbs, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const shortId = randomBytes(3).toString('hex')
  const fileName = `${stamp}-${shortId}.md`
  const relativePath = `${HARNESS_PROPOSALS_REL}/${fileName}`.replace(/\\/g, '/')
  const proposalPath = resolveInsideWorkspace(workspacePath, relativePath)
  writeFileSync(proposalPath, buildProposalMarkdown(workspacePath, summary, opts), 'utf8')
  return { proposalPath, relativePath }
}

/** Mine receipts and write a workspace-visible proposal markdown. */
export async function runHarnessReview(
  workspacePath: string,
  opts?: { limit?: number }
): Promise<HarnessReviewResult> {
  const receipts = collectRecentReceipts(workspacePath, opts)
  const summary = summarizeWeaknesses(receipts)

  let trajRuns = 0
  let predRuns = 0
  for (const { runId } of receipts) {
    try {
      const runDir = resolveRunDir(workspacePath, runId)
      if (trajectoryArtifactExists(runDir)) trajRuns++
      if (predictionArtifactExists(runDir)) predRuns++
    } catch {
      // skip unreadable run dirs
    }
  }
  if (trajRuns > 0) {
    summary.bullets.push(
      `${trajRuns} run(s) have observational \`trajectory.jsonl\` (AHE flight recorder — not auto-merged).`
    )
  }
  if (predRuns > 0) {
    summary.bullets.push(
      `${predRuns} run(s) have observational \`prediction.json\` (observed_only — never auto-applied to harness).`
    )
  }

  const written = writeHarnessProposal(workspacePath, summary)
  return {
    proposalPath: written.proposalPath,
    relativePath: written.relativePath,
    receiptCount: summary.receiptCount,
    summary: summary.bullets.join('\n')
  }
}
