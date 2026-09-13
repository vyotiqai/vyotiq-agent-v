import { describe, expect, it } from 'vitest'
import { extractFoldFacts } from '@main/agent/context/foldFacts'
import { pinFoldFacts } from '@main/agent/context/pinFoldFacts'
import {
  requiredFoldFactsFocus,
  verifyCompactionSummary
} from '@main/agent/context/verifyCompaction'
import {
  CANARIES,
  PLANTED_CONTRACT,
  plantedFoldMessages
} from './compactionLossExam.fixture'

function baseSummary(overrides: Partial<Record<string, string>> = {}): string {
  const intent = overrides.intent ?? CANARIES.contractGoal
  const files = overrides.files ?? `- ${CANARIES.writePath}\n- ${CANARIES.inspectPath}`
  const decisions = overrides.decisions ?? `- ${CANARIES.decision}`
  const constraints = overrides.constraints ?? `- Do not mention ${CANARIES.userProse} in any log.`
  const blockers = overrides.blockers ?? '- (none)'
  const next = overrides.next ?? `- ${CANARIES.todo}\n- ${CANARIES.readBody}\n- ${CANARIES.term}\n- ${CANARIES.doneWhen}`
  return [
    `## Session Intent\n${intent}`,
    `## Files Touched\n${files}`,
    `## Key Decisions\n${decisions}`,
    `## Constraints\n${constraints}`,
    `## Open Bugs/Blockers\n${blockers}`,
    `## Next Steps\n${next}`
  ].join('\n\n')
}

describe('compaction loss exam (planted canaries)', () => {
  const messages = plantedFoldMessages()
  const facts = extractFoldFacts(messages, { contract: PLANTED_CONTRACT })
  const foldedText = messages.map((m) => String(m.content ?? '')).join('\n')

  it('extractor sees fail-closed facts including user constraints; tool-body dumps stay out', () => {
    expect(facts.decisions.some((d) => d.includes('planted-choice-9f3a'))).toBe(true)
    expect(facts.wroteFiles).toContain(CANARIES.writePath)
    expect(facts.files).toContain(CANARIES.writePath)
    expect(facts.files).toContain(CANARIES.inspectPath)
    expect(facts.todos).toContain(CANARIES.todo)
    expect(facts.doneWhen).toContain(CANARIES.doneWhen)
    expect(facts.contractGoal).toBe(CANARIES.contractGoal)
    expect(facts.constraints?.some((line) => line.includes(CANARIES.userProse))).toBe(true)

    const blob = JSON.stringify(facts)
    expect(blob).not.toContain(CANARIES.readBody)
    expect(blob).not.toContain(CANARIES.term)

    const focus = requiredFoldFactsFocus(facts)
    expect(focus).toContain(CANARIES.todo)
    expect(focus).toContain(CANARIES.doneWhen)
    expect(focus).toContain(CANARIES.writePath)
    expect(focus).toContain(CANARIES.contractGoal)
    expect(focus).toContain(CANARIES.userProse)
  })

  it('faithful summary that cites writes, decision, and goal passes', () => {
    const result = verifyCompactionSummary(baseSummary(), facts, foldedText)
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('dropping ask_question answer fail-closes (missing_decision)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ decisions: '- (none)' }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_decision')).toBe(true)
  })

  it('dropping written file fail-closes (missing_wrote_file)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ files: `- ${CANARIES.inspectPath}` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_wrote_file')).toBe(true)
  })

  it('dropping contract goal fail-closes (missing_contract_goal)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ intent: 'Did some auth work' }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_contract_goal')).toBe(true)
  })

  it('invented path fail-closes (invented_path)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ files: `- ${CANARIES.writePath}\n- src/invented/canary.ts` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'invented_path')).toBe(true)
  })

  it('dropping read-body canary still verifies (blind)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ next: `- ${CANARIES.todo}\n- ${CANARIES.doneWhen}` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(true)
  })

  it('dropping terminal canary still verifies (blind)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ next: `- ${CANARIES.todo}\n- ${CANARIES.doneWhen}` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(true)
  })

  it('dropping user-prose canary fail-closes (missing_constraint)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ constraints: '- Keep diffs small' }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_constraint')).toBe(true)
  })

  it('dropping open todo fail-closes (missing_todo)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ next: `- ${CANARIES.doneWhen}` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_todo')).toBe(true)
  })

  it('dropping done-when bullet fail-closes (missing_done_when)', () => {
    const result = verifyCompactionSummary(
      baseSummary({ next: `- ${CANARIES.todo}` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_done_when')).toBe(true)
  })

  it('writes skip inspect-file coverage so omitting the read path still verifies', () => {
    const result = verifyCompactionSummary(
      baseSummary({ files: `- ${CANARIES.writePath}` }),
      facts,
      foldedText
    )
    expect(result.ok).toBe(true)
    expect(result.failures.some((f) => f.kind === 'low_file_coverage')).toBe(false)
  })

  it('pinFoldFacts restores omitted fail-closed facts so verify passes', () => {
    const amnesia = `## Session Intent
Did some work

## Files Touched
- (none)

## Key Decisions
- (none)`
    expect(verifyCompactionSummary(amnesia, facts, foldedText).ok).toBe(false)
    const pinned = pinFoldFacts(amnesia, facts)
    const result = verifyCompactionSummary(pinned, facts, foldedText)
    expect(result.ok).toBe(true)
    expect(pinned).toContain(CANARIES.writePath)
    expect(pinned).toContain(CANARIES.decision)
    expect(pinned).toContain(CANARIES.contractGoal)
    expect(pinned).toContain(CANARIES.todo)
    expect(pinned).toContain(CANARIES.doneWhen)
    expect(pinned).toContain(CANARIES.userProse)
    expect(pinned).toContain(CANARIES.inspectPath)
    expect(pinned).not.toContain(CANARIES.readBody)
    expect(pinned).not.toContain(CANARIES.term)
  })
})
