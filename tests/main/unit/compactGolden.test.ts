import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import { extractFoldFacts } from '@main/agent/context/foldFacts'
import { pinFoldFacts } from '@main/agent/context/pinFoldFacts'
import {
  untrustworthy,
  verifyCompactionSummary,
  type CompactionVerifyFailureKind
} from '@main/agent/context/verifyCompaction'

type GoldenSummary = {
  id: string
  expectOk: boolean
  failKinds?: CompactionVerifyFailureKind[]
  text: string
}

type CompactGolden = {
  id: string
  description: string
  contract?: string
  messages: ChatMessage[]
  mustKeep: {
    decisions?: string[]
    wroteFiles?: string[]
    contractGoal?: string
  }
  mustNotInvent?: string[]
  summaries: GoldenSummary[]
}

const FIXTURE_DIR = join(__dirname, '../../fixtures/compact')

function loadGoldens(): CompactGolden[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as CompactGolden
      return raw
    })
}

describe('compact golden fixtures', () => {
  const goldens = loadGoldens()

  it('loads labeled compact goldens', () => {
    expect(goldens.map((g) => g.id).sort()).toEqual(['auth-rewrite', 'chat-only'])
  })

  for (const golden of goldens) {
    describe(golden.id, () => {
      const facts = extractFoldFacts(golden.messages, { contract: golden.contract })

      it('extracts labeled must-keep facts', () => {
        for (const decision of golden.mustKeep.decisions ?? []) {
          expect(facts.decisions).toContain(decision)
        }
        for (const path of golden.mustKeep.wroteFiles ?? []) {
          expect(facts.wroteFiles).toContain(path)
        }
        if (golden.mustKeep.contractGoal) {
          expect(facts.contractGoal).toBe(golden.mustKeep.contractGoal)
        }
      })

      for (const summary of golden.summaries) {
        // Scored as the model wrote it. Pinning used to run first for the
        // `expectOk` cases, which made every `missing_*` kind unreachable and
        // the assertion a test of the pinner rather than the scorer.
        it(`summary ${summary.id} ${summary.expectOk ? 'passes' : 'fails'} the extractive scorer`, () => {
          const result = verifyCompactionSummary(summary.text, facts)
          expect(result.ok).toBe(summary.expectOk)
          if (summary.failKinds) {
            for (const kind of summary.failKinds) {
              expect(result.failures.some((f) => f.kind === kind)).toBe(true)
            }
          }
          for (const invented of golden.mustNotInvent ?? []) {
            if (summary.text.includes(invented)) {
              expect(result.failures.some((f) => f.kind === 'invented_path')).toBe(true)
            }
          }
        })

        // The pipeline contract: omissions are repaired from the extracted
        // facts, hallucinations are not — those are what earn a retry.
        it(`summary ${summary.id} pins to a clean summary unless it invented a path`, () => {
          const scored = verifyCompactionSummary(summary.text, facts)
          const pinned = pinFoldFacts(summary.text, facts)
          const after = verifyCompactionSummary(pinned, facts)
          const hallucinated = untrustworthy(scored).length > 0
          expect(after.ok).toBe(!hallucinated)
          expect(untrustworthy(after).length > 0).toBe(hallucinated)
        })
      }
    })
  }
})
