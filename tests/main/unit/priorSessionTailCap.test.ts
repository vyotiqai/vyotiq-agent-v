import { describe, expect, it } from 'vitest'
import {
  assembleContext,
  capTailToTokenBudget,
  clearSystemPromptCache,
  PRIOR_SESSION_TAIL_MARKER
} from '@main/agent/context/assemble'
import { estimateTextTokens } from '@main/agent/context/estimate'
import type { ModelInfo } from '@shared/ipc'

const model: ModelInfo = {
  id: 'test',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  contextWindow: 100_000
}

function foldNarrative(n: number, lines: number): string {
  const out: string[] = ['## Session Intent', `Fold ${n} narrative.`]
  for (let i = 0; i < lines; i++) {
    out.push(`- Fold ${n} step ${i}: inspected src/module${n}_${i}.ts and adjusted handler ${i * 7}.`)
  }
  return out.join('\n')
}

/** compactMessages' rolling merge: `${prior}\n\n---\n\n${summary}`, newest last. */
const rolling = [
  foldNarrative(1, 300),
  foldNarrative(2, 300),
  `${foldNarrative(3, 20)}\nNEWEST_FOLD_MARKER`
].join('\n\n---\n\n')

async function assembleWith(summary: string): Promise<string> {
  const result = await assembleContext({
    harness: '## Role\nAgent',
    messages: [{ role: 'user', content: 'continue' }],
    workspacePath: null,
    goal: 'continue',
    model,
    toolsJsonEstimate: 50,
    providerId: 'ollama',
    priorCompaction: { summary, createdAt: '2026-01-01T00:00:00.000Z', tokenEstimate: 1 }
  })
  return result.systemStable
}

describe('<prior_session> keeps the newest fold when the narrative is over its cap', () => {
  it('drops the oldest fold, not the one describing current state', async () => {
    clearSystemPromptCache()
    const stable = await assembleWith(rolling)
    expect(stable).toContain('NEWEST_FOLD_MARKER')
    expect(stable).toContain('Fold 3 narrative.')
    expect(stable).not.toContain('Fold 1 narrative.')
    expect(stable).toContain(PRIOR_SESSION_TAIL_MARKER)
  })

  it('renders byte-identical stable bytes for an identical summary', async () => {
    clearSystemPromptCache()
    const first = await assembleWith(rolling)
    clearSystemPromptCache()
    const second = await assembleWith(rolling)
    expect(second).toBe(first)
  })

  it('cuts on a fold separator when the kept tail holds one, and fits the budget', () => {
    const capped = capTailToTokenBudget(rolling, 2_000, model)
    expect(estimateTextTokens(capped, model)).toBeLessThanOrEqual(2_000)
    const body = capped.slice(PRIOR_SESSION_TAIL_MARKER.length + 1)
    expect(capped.startsWith(`${PRIOR_SESSION_TAIL_MARKER}\n`)).toBe(true)
    // Starts on a whole fold (or a whole line), never mid-line.
    expect(rolling.includes(`\n${body.split('\n')[0]}\n`)).toBe(true)
    expect(body.endsWith('NEWEST_FOLD_MARKER')).toBe(true)
  })

  it('leaves a narrative that fits untouched', () => {
    const small = foldNarrative(1, 3)
    expect(capTailToTokenBudget(small, 5_000, model)).toBe(small)
  })
})
