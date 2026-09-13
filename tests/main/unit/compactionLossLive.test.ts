import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { compactMessages } from '@main/agent/context/compact'
import { extractFoldFacts } from '@main/agent/context/foldFacts'
import { pinFoldFacts } from '@main/agent/context/pinFoldFacts'
import {
  requiredFoldFactsFocus,
  verifyCompactionSummary
} from '@main/agent/context/verifyCompaction'
import { resetCircuitBreakersForTests } from '@main/agent/circuitBreaker'
import { openrouterProvider } from '@main/agent/providers/openai'
import {
  CANARIES,
  PLANTED_CONTRACT,
  plantedFoldMessages
} from './compactionLossExam.fixture'

const RESULT_PATH = join(tmpdir(), 'vyotiq-compaction-loss-live.json')

type LiveResult = {
  attempted: boolean
  reason: string
  model?: string
  verifyOk?: boolean
  failureKinds?: string[]
  canaries: Record<string, boolean>
  summaryChars?: number
}

function canaryHits(summary: string): Record<string, boolean> {
  return {
    decision: summary.includes('planted-choice-9f3a'),
    writePath: summary.includes(CANARIES.writePath) || summary.includes('canary-write-7e91'),
    inspectPath: summary.includes('canary-inspect-a4c2'),
    readBody: summary.includes('secret-from-read-k3n7'),
    term: summary.includes('secret-from-bash-w1p4'),
    userProse: summary.includes('never-commit-secret-zeta'),
    todo: summary.includes('open-todo-title-q8m2'),
    doneWhen: summary.includes('login-must-use-jwt-p6d1'),
    contractGoal: summary.includes('rewrite-auth-to-jwt-m2c8')
  }
}

describe('compaction loss exam (live summarizer)', () => {
  it('compacts the planted transcript with the configured OpenRouter model', async () => {
    resetCircuitBreakersForTests()
    const apiKey = process.env.OPENROUTER_API_KEY?.trim()
    if (!apiKey) {
      const skipped: LiveResult = {
        attempted: false,
        reason: 'OPENROUTER_API_KEY unset — decrypt via Electron safeStorage and re-run',
        canaries: canaryHits('')
      }
      writeFileSync(RESULT_PATH, JSON.stringify(skipped, null, 2))
      expect(skipped.attempted).toBe(false)
      return
    }

    const messages = plantedFoldMessages()
    const facts = extractFoldFacts(messages, { contract: PLANTED_CONTRACT })
    const foldedText = messages.map((m) => String(m.content ?? '')).join('\n')
    const model = process.env.OPENROUTER_MODEL?.trim() || 'stealth/ox-alpha'
    const record = await compactMessages({
      provider: openrouterProvider,
      model,
      apiKey,
      signal: AbortSignal.timeout(180_000),
      messages,
      supportsStructuredOutput: true,
      contextWindow: 128_000,
      focus: requiredFoldFactsFocus(facts)
    })

    if (!record?.summary) {
      const failed: LiveResult = {
        attempted: true,
        reason: 'compactMessages returned no summary',
        model,
        canaries: canaryHits('')
      }
      writeFileSync(RESULT_PATH, JSON.stringify(failed, null, 2))
      throw new Error(failed.reason)
    }

    const pinned = pinFoldFacts(record.summary, facts)
    const scored = verifyCompactionSummary(pinned, facts, foldedText)
    const result: LiveResult = {
      attempted: true,
      reason: scored.ok ? 'summary verified' : scored.failures.map((f) => f.kind).join(','),
      model,
      verifyOk: scored.ok,
      failureKinds: scored.failures.map((f) => f.kind),
      canaries: canaryHits(pinned),
      summaryChars: pinned.length
    }
    writeFileSync(RESULT_PATH, JSON.stringify({ ...result, summary: pinned }, null, 2))
    expect(result.attempted).toBe(true)
  }, 200_000)
})
