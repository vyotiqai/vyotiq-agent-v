import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { assembleContext, clearSystemPromptCache } from '@main/agent/context/assemble'
import { estimateTextTokens } from '@main/agent/context/estimate'
import {
  getTokenizerPerfStats,
  resetTokenizerCache,
  resetTokenizerPerfStats
} from '@main/agent/context/tokenizer'
import type { ChatMessage, ModelInfo } from '@shared/ipc'

const model: ModelInfo = {
  id: 'test',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  contextWindow: 200_000
}

const harness = readFileSync(join(__dirname, '../../../resources/harness/default.md'), 'utf8')

function words(seed: number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`w${(seed * 31 + i * 7) % 997}_${i % 13}`)
  return out.join(' ')
}

const messages: ChatMessage[] = [
  { role: 'user', content: 'Refactor the auth module' },
  { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }] },
  { role: 'tool', toolCallId: 'c1', toolName: 'read', content: words(1, 300) }
]

function sessionEnv(step: number): string {
  const at = new Date(Date.UTC(2026, 8, 26, 10, 0, step)).toISOString()
  return `<session>\nDate (UTC): ${at}\nOS: Windows x64\n</session>`
}

function step(n: number) {
  return assembleContext({
    harness,
    messages,
    workspacePath: null,
    goal: 'Refactor the auth module',
    model,
    toolsJsonEstimate: 1_000,
    providerId: 'ollama',
    skillsSection: `<available_skills>\n${words(3, 500)}\n</available_skills>`,
    plan: `# Plan\n${words(5, 400)}`,
    planVerbatim: true,
    sessionEnv: sessionEnv(n),
    loopHint: `Step ${n} notice.`,
    taskList: '<task_list>\n[ ] (1) Refactor\n</task_list>'
  })
}

describe('system layer tokens', () => {
  it('stays within a few tokens of encoding the whole system string', async () => {
    clearSystemPromptCache()
    for (let n = 0; n < 3; n++) {
      const result = await step(n)
      const whole = estimateTextTokens(result.system, model)
      expect(result.system.length).toBeGreaterThan(15_000)
      expect(Math.abs(result.layers.system - whole)).toBeLessThanOrEqual(3)
    }
  })

  it('does not re-encode the whole system string when only the volatile zone changed', async () => {
    clearSystemPromptCache()
    resetTokenizerCache()
    await step(0)
    resetTokenizerPerfStats()
    await step(1)
    const stats = getTokenizerPerfStats()
    // Messages are unchanged and the stable zone is byte-identical: nothing is
    // left for the batched encoder. The volatile zone is counted on its own.
    expect(stats.syncFallbacks + stats.workerBatches).toBe(0)
  })
})
