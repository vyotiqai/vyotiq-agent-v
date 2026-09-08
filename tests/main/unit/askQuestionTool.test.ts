import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import type { AgentQuestionAnswer } from '@shared/ipc'
import {
  ASK_QUESTION_ARGS_HINT,
  ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE,
  ASK_QUESTION_NO_ANSWER_GUIDANCE
} from '@shared/utils/agentQuestionForm'
import { AGENT_TOOLS, validateToolArgs } from '@main/agent/schemas/tools'
import { mergeOpenAiCompatToolArgDelta } from '@main/agent/toolArgWire'

const getSettings = vi.hoisted(() =>
  vi.fn(() => ({ ...DEFAULT_SETTINGS, autoModeSwitch: true }))
)

vi.mock('@main/settings/settings', () => ({
  getSettings: () => getSettings()
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'

describe('ask_question tool', () => {
  beforeEach(() => {
    getSettings.mockReset()
    getSettings.mockReturnValue({ ...DEFAULT_SETTINGS, autoModeSwitch: true })
  })

  it('publishes questions[] item shape with type enum (not empty {})', () => {
    const def = AGENT_TOOLS.find((t) => t.name === 'ask_question')
    expect(def).toBeTruthy()
    const params = def!.parameters as {
      properties: {
        questions: {
          type?: string
          description?: string
          minItems?: number
          items?: {
            type?: string
            properties?: {
              prompt?: { type?: string }
              type?: { type?: string; enum?: string[] }
            }
            required?: string[]
          }
        }
        prompt?: { type?: string }
      }
    }
    expect(params.properties.questions.type).toBe('array')
    expect(params.properties.questions.minItems).toBe(1)
    expect(params.properties.questions.items?.properties?.prompt?.type).toBe('string')
    expect(params.properties.questions.items?.properties?.type?.enum).toEqual([
      'single',
      'multi',
      'boolean',
      'text'
    ])
    expect(params.properties.questions.items?.required).toEqual(
      expect.arrayContaining(['prompt', 'type'])
    )
    expect(params.properties.prompt?.type).toBe('string')
  })

  it('fails without a question sender', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Continue?' }),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/none is listening/i)
  })

  it('returns summarized answers from a mock ask (legacy args)', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Pick one', options: ['A', 'B'] }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async () => [{ questionId: 'q1', values: ['A'] }]
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe('User answered: A')
  })

  it('formats multi-question answers with prompts', async () => {
    const captured: AgentQuestionAnswer[] = []
    const result = await executeTool(
      'ask_question',
      JSON.stringify({
        title: 'Setup',
        questions: [
          { id: 'mode', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'] },
          { id: 'go', prompt: 'Continue?', type: 'boolean' }
        ]
      }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async (_req) => {
          const answers = [
            { questionId: 'mode', values: ['Ask'] },
            { questionId: 'go', values: ['Yes'] }
          ]
          captured.push(...answers)
          return answers
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('Setup')
    expect(result.content).toBe('User answered:\n- Mode?: Ask\n- Continue?: Yes')
    expect(captured).toHaveLength(2)
  })

  it('coerces single/multi without enough options to text (live a1a46c65)', async () => {
    let asked: { questions: Array<{ type: string; options?: string[] }> } | null = null
    const result = await executeTool(
      'ask_question',
      JSON.stringify({
        questions: [{ id: 'q1', prompt: 'Only one?', type: 'single', options: ['A'] }]
      }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async (req) => {
          asked = req as typeof asked
          return [{ questionId: 'q1', values: ['A'] }]
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(asked?.questions[0]!.type).toBe('text')
    expect(asked?.questions[0]!.options).toBeUndefined()
    expect(result.content).toBe('User answered: A')
  })

  it('skips in autonomous mode only when autonomousSkipQuestions is skip', async () => {
    getSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      autoModeSwitch: true,
      autonomousMode: true,
      autonomousSkipQuestions: 'skip'
    })
    const askQuestion = vi.fn()
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Continue?' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/skipped \(autonomous mode\)/i)
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('waits for answers in autonomous mode when autonomousSkipQuestions is wait', async () => {
    getSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      autoModeSwitch: true,
      autonomousMode: true,
      autonomousSkipQuestions: 'wait'
    })
    const askQuestion = vi.fn(async () => [{ questionId: 'q1', values: ['Yes'] }])
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Continue?' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe('User answered: Yes')
    expect(askQuestion).toHaveBeenCalledOnce()
  })

  it('returns ok guidance when the form is skipped or times out', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Continue?' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async () => []
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe(ASK_QUESTION_NO_ANSWER_GUIDANCE)
    expect(result.content).not.toMatch(/ask again/i)
  })

  it('accepts top-level prompt alias and enriches empty-args failures', async () => {
    const ok = await executeTool(
      'ask_question',
      JSON.stringify({ prompt: 'Ready?' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async () => [{ questionId: 'q1', values: ['yes'] }]
      }
    )
    expect(ok.ok).toBe(true)
    expect(ok.content).toBe('User answered: yes')

    const bad = await executeTool(
      'ask_question',
      JSON.stringify({}),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(bad.ok).toBe(false)
    expect(bad.summary).toBe('Invalid arguments')
    expect(bad.content).toMatch(/question or questions is required/i)
    expect(bad.content).toContain(ASK_QUESTION_ARGS_HINT)
  })

  it('returns enriched failures for empty questions[] and invalid type/missing prompt', async () => {
    const empty = await executeTool(
      'ask_question',
      JSON.stringify({ questions: [] }),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(empty.ok).toBe(false)
    expect(empty.summary).toBe('Invalid arguments')
    expect(empty.content).toMatch(/at least 1 item/i)
    expect(empty.content).toContain(ASK_QUESTION_ARGS_HINT)

    const noType = await executeTool(
      'ask_question',
      JSON.stringify({
        questions: [
          {
            allowCustom: true,
            id: 'direction',
            options: ['Compact dashboard', 'Minimal launcher'],
            prompt: 'Which direction should the redesign take?'
          }
        ]
      }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        // Omitted type is inferred (single with 2+ options) instead of failing —
        // live 3d334c22/870cde12/829b9ada all omitted type on optioned questions.
        askQuestion: async () => [{ questionId: 'direction', values: ['Compact dashboard'] }]
      }
    )
    expect(noType.ok).toBe(true)
    expect(noType.content).toBe('User answered: Compact dashboard')

    const badType = await executeTool(
      'ask_question',
      JSON.stringify({ questions: [{ id: 'q1', prompt: 'Go?', type: 'choice' }] }),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(badType.ok).toBe(false)
    // Prompt is still recoverable for the tool row title; content carries the schema error.
    expect(badType.summary).toBe('Go?')
    expect(badType.content).toMatch(/type must be single, multi, boolean, or text/i)
    expect(badType.content).toMatch(/Each questions\[\]\.type must be one of/i)

    const noPrompt = await executeTool(
      'ask_question',
      JSON.stringify({ questions: [{ id: 'q1', type: 'boolean' }] }),
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1' }
    )
    expect(noPrompt.ok).toBe(false)
    // No recoverable prompt — summarizer falls back to count; content has the required-field hint.
    expect(noPrompt.summary).toBe('1 questions')
    expect(noPrompt.content).toMatch(/prompt is required/i)
    expect(noPrompt.content).toMatch(/prompt \(or question as an alias\)/i)
  })

  it('executes the live 0898dc11 unclosed stringified questions payload', async () => {
    const questions =
      '[{"id": "purpose", "prompt": "What task or workflow should this skill handle? Describe the outcome, the inputs, and any domain knowledge or rules the agent needs (e.g. \'generate REST endpoints from an OpenAPI spec\', \'review PRs for security issues\', \'write release notes from a changelog\').", "type": "text"}, {"id": "placement", "prompt": "Where should the skill live?", "type": "single", "options": ["Personal (~/.vyotiq/skills/<name> — reusable across your projects)", "Project (./.vyotiq/skills/<name> — this deamon project only)", "Marketplace (bundled in Vyotiq source — ships to all users)", "Recommend the best fit"]}'
    const liveArgs = JSON.stringify({
      title: 'New skill — what should it do?',
      questions
    })
    const result = await executeTool(
      'ask_question',
      liveArgs,
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-0898dc11',
        toolCallId: 'tc-live',
        askQuestion: async () => [
          { questionId: 'purpose', values: ['Find real bugs'] },
          { questionId: 'placement', values: ['Personal (~/.vyotiq/skills)'] }
        ]
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('New skill — what should it do?')
    expect(result.content).toMatch(/Find real bugs/)
  })

  it('executes bare questions arrays and stringified questions via wire+validate', async () => {
    const bare = await executeTool(
      'ask_question',
      JSON.stringify([{ id: 'q1', prompt: 'Bare?', type: 'boolean' }]),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async () => [{ questionId: 'q1', values: ['Yes'] }]
      }
    )
    expect(bare.ok).toBe(true)
    expect(bare.content).toBe('User answered: Yes')

    const coerced = validateToolArgs(
      'ask_question',
      JSON.stringify({
        questions: JSON.stringify([{ id: 'q1', prompt: 'Ready?', type: 'text' }])
      })
    )
    expect(coerced.ok).toBe(true)
    if (!coerced.ok) return
    expect(coerced.data.questions).toEqual([
      { id: 'q1', prompt: 'Ready?', type: 'text' }
    ])

    const missing = validateToolArgs('ask_question', '{}')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error).toContain(ASK_QUESTION_ARGS_HINT)
  })

  it('asks the form for arguments streamed as {"questions": then [ (live 4406e6a2)', async () => {
    // Provider chunking that used to lose the object prefix and arrive as `[…]}`.
    const chunks = [
      '{"questions": ',
      '[{"id": "topic", "prompt": "What topic should I research?", "type": "single", "options": ["AI coding agents", "Frontend"], "allowCustom": true}',
      ', {"id": "output", "prompt": "How would you like it delivered?", "type": "single", "options": ["Chat summary", "Markdown file"]}]',
      '}'
    ]
    let streamed = ''
    for (const chunk of chunks) {
      streamed = mergeOpenAiCompatToolArgDelta(streamed, chunk).arguments
    }

    let asked: { questions: Array<{ id: string; prompt: string }> } | null = null
    const result = await executeTool(
      'ask_question',
      streamed,
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async (req) => {
          asked = req as typeof asked
          return [
            { questionId: 'topic', values: ['AI coding agents'] },
            { questionId: 'output', values: ['Chat summary'] }
          ]
        }
      }
    )

    expect(result.ok).toBe(true)
    expect(asked?.questions.map((q) => q.id)).toEqual(['topic', 'output'])
    expect(result.content).toBe(
      'User answered:\n- What topic should I research?: AI coding agents\n- How would you like it delivered?: Chat summary'
    )
  })

  it('recovers arguments that arrive as an array plus a stray closing brace', async () => {
    const result = await executeTool(
      'ask_question',
      '[{"id": "topic", "prompt": "Which topic?", "type": "single", "options": ["A", "B"]}]}',
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: async () => [{ questionId: 'topic', values: ['A'] }]
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe('User answered: A')
  })

  it('reports malformed arguments instead of claiming questions is missing', async () => {
    const askQuestion = vi.fn()
    const result = await executeTool(
      'ask_question',
      '{"questions": [{"id": "topic", "prompt": "Which topic',
      '/ws',
      new AbortController().signal,
      { runId: 'run-1', toolCallId: 'tc-1', askQuestion }
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('Invalid arguments')
    expect(result.content).toMatch(/must be one complete JSON object/i)
    expect(result.content).not.toMatch(/question or questions is required/i)
    expect(result.content).toContain(ASK_QUESTION_ARGS_HINT)
    expect(askQuestion).not.toHaveBeenCalled()
  })

  it('uses the autonomous skip guidance constant when skipping', async () => {
    getSettings.mockReturnValue({
      ...DEFAULT_SETTINGS,
      autoModeSwitch: true,
      autonomousMode: true,
      autonomousSkipQuestions: 'skip'
    })
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ question: 'Continue?' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        askQuestion: vi.fn()
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe(ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE)
  })
})
