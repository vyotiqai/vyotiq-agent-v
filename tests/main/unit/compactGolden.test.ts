import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import { extractFoldFacts } from '@main/agent/context/foldFacts'
import { pinFoldFacts } from '@main/agent/context/pinFoldFacts'
import {
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
        it(`summary ${summary.id} ${summary.expectOk ? 'passes' : 'fails'} the extractive scorer`, () => {
          const text = summary.expectOk ? pinFoldFacts(summary.text, facts) : summary.text
          const result = verifyCompactionSummary(text, facts)
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
      }
    })
  }
})
