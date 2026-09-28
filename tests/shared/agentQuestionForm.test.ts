import { describe, expect, it } from 'vitest'
import {
  AGENT_QUESTION_MAX_ANSWER_CHARS,
  AGENT_QUESTION_MAX_ITEMS,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MAX_PROMPT_CHARS,
  AGENT_QUESTION_MAX_TITLE_CHARS,
  ASK_QUESTION_NO_ANSWER_GUIDANCE,
  askQuestionSummary,
  formatQuestionAnswers,
  normalizeAskQuestionArgs,
  sanitizeQuestionAnswers,
  type AgentQuestionItem
} from '@shared/utils/agentQuestionForm'

describe('normalizeAskQuestionArgs', () => {
  it('normalizes legacy question + options to single', () => {
    const result = normalizeAskQuestionArgs({
      question: 'Pick?',
      options: ['A', 'B'],
      allowCustom: false
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions).toEqual([
      {
        id: 'q1',
        prompt: 'Pick?',
        type: 'single',
        options: ['A', 'B'],
        allowCustom: false
      }
    ])
  })

  it('normalizes legacy allowMultiple to multi with allowCustom default true', () => {
    const result = normalizeAskQuestionArgs({
      question: 'Features?',
      options: ['A', 'B'],
      allowMultiple: true
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.type).toBe('multi')
    expect(result.form.questions[0]!.allowCustom).toBe(true)
  })

  it('accepts typed questions array', () => {
    const result = normalizeAskQuestionArgs({
      title: 'Setup',
      questions: [
        { id: 'a', prompt: 'Go?', type: 'boolean' },
        { id: 'b', prompt: 'Notes', type: 'text' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.title).toBe('Setup')
    expect(result.form.questions).toHaveLength(2)
  })

  it('accepts question as alias for prompt on typed items', () => {
    const result = normalizeAskQuestionArgs({
      questions: [
        {
          id: 'scope',
          question: 'Should I only review, revise, or prepare for /harness?',
          type: 'single',
          options: ['Review only', 'Revise proposal', 'Prepare for /harness']
        }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe(
      'Should I only review, revise, or prepare for /harness?'
    )
  })

  it('prefers prompt when both question and prompt are set', () => {
    const result = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Canonical', question: 'Alias', type: 'boolean' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe('Canonical')
  })

  it('parses stringified questions JSON array', () => {
    const result = normalizeAskQuestionArgs({
      questions: JSON.stringify([{ id: 'q1', prompt: 'Ready?', type: 'boolean' }])
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.type).toBe('boolean')
  })

  it('salvages an unclosed stringified questions array (live 0898dc11)', () => {
    const items = [
      {
        id: 'purpose',
        prompt: 'What task or workflow should this skill handle?',
        type: 'text'
      },
      {
        id: 'placement',
        prompt: 'Where should the skill live?',
        type: 'single',
        options: [
          'Personal (~/.vyotiq/skills/<name> — reusable across your projects)',
          'Project (./.vyotiq/skills/<name> — this deamon project only)',
          'Marketplace (bundled in Vyotiq source — ships to all users)',
          'Recommend the best fit'
        ]
      }
    ]
    const result = normalizeAskQuestionArgs({
      title: 'New skill — what should it do?',
      questions: JSON.stringify(items).slice(0, -1)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.title).toBe('New skill — what should it do?')
    expect(result.form.questions.map((q) => q.id)).toEqual(['purpose', 'placement'])
    expect(result.form.questions[1]!.options).toHaveLength(4)
  })

  it('wraps a single question object and parses stringified options', () => {
    const asObject = normalizeAskQuestionArgs({
      questions: { id: 'q1', prompt: 'Ready?', type: 'boolean' }
    })
    expect(asObject.ok).toBe(true)
    if (!asObject.ok) return
    expect(asObject.form.questions).toHaveLength(1)
    expect(asObject.form.questions[0]!.prompt).toBe('Ready?')

    const stringOptions = normalizeAskQuestionArgs({
      questions: [
        {
          id: 'placement',
          prompt: 'Where?',
          type: 'single',
          options: JSON.stringify(['Personal', 'Project', 'Marketplace', 'Recommend'])
        }
      ]
    })
    expect(stringOptions.ok).toBe(true)
    if (!stringOptions.ok) return
    expect(stringOptions.form.questions[0]!.options).toEqual([
      'Personal',
      'Project',
      'Marketplace',
      'Recommend'
    ])
  })

  it('unwraps a double-encoded questions array', () => {
    const items = [{ id: 'q1', prompt: 'Ready?', type: 'text' }]
    const result = normalizeAskQuestionArgs({
      questions: JSON.stringify(JSON.stringify(items))
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe('Ready?')
  })

  it('rejects malformed stringified questions array', () => {
    const malformed =
      '[{"id": "how_open", "prompt": "How?", "type": "single", "options": ["A VS Code "Live Server" or similar", "Other"]}]'
    const result = normalizeAskQuestionArgs({ questions: malformed })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/JSON array/i)
  })

  it('accepts top-level prompt as alias for legacy question', () => {
    const result = normalizeAskQuestionArgs({ prompt: 'Ship it?' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]!.prompt).toBe('Ship it?')
    expect(result.form.questions[0]!.type).toBe('text')
  })

  it('enriches missing question/questions with an example payload', () => {
    const result = normalizeAskQuestionArgs({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/question or questions is required/i)
    expect(result.error).toMatch(/type: "boolean"/i)
  })

  it('rejects empty questions array with a distinct error', () => {
    const result = normalizeAskQuestionArgs({ questions: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/at least 1 item/i)
    expect(result.error).toMatch(/Pass questions:/i)
  })

  it('rejects an invalid type but infers an omitted type from options (live 3d334c22/870cde12/829b9ada)', () => {
    const badType = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Go?', type: 'choice' }]
    })
    expect(badType.ok).toBe(false)
    if (badType.ok) return
    expect(badType.error).toMatch(/type must be single, multi, boolean, or text/i)

    const noTypeWithOptions = normalizeAskQuestionArgs({
      questions: [
        {
          allowCustom: true,
          id: 'direction',
          options: ['Compact dashboard', 'Minimal launcher', 'Fix visual layer', 'You decide'],
          prompt: 'Which direction should the redesign take?'
        }
      ]
    })
    expect(noTypeWithOptions.ok).toBe(true)
    if (!noTypeWithOptions.ok) return
    expect(noTypeWithOptions.form.questions[0]).toEqual({
      id: 'direction',
      prompt: 'Which direction should the redesign take?',
      type: 'single',
      options: ['Compact dashboard', 'Minimal launcher', 'Fix visual layer', 'You decide'],
      allowCustom: true
    })

    const noTypeNoOptions = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Go?' }]
    })
    expect(noTypeNoOptions.ok).toBe(true)
    if (!noTypeNoOptions.ok) return
    expect(noTypeNoOptions.form.questions[0]).toEqual({ id: 'q1', prompt: 'Go?', type: 'text' })

    const noPrompt = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', type: 'boolean' }]
    })
    expect(noPrompt.ok).toBe(false)
    if (noPrompt.ok) return
    expect(noPrompt.error).toMatch(/prompt is required/i)
  })

  it('rejects duplicate ids', () => {
    const result = normalizeAskQuestionArgs({
      questions: [
        { id: 'same', prompt: 'A?', type: 'boolean' },
        { id: 'same', prompt: 'B?', type: 'text' }
      ]
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/duplicate question id/i)
  })

  it('coerces single/multi with fewer than 2 valid options to text', () => {
    const one = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Only one?', type: 'single', options: ['A'] }]
    })
    expect(one.ok).toBe(true)
    if (!one.ok) return
    expect(one.form.questions[0]).toEqual({ id: 'q1', prompt: 'Only one?', type: 'text' })

    const dupes = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Dupes?', type: 'single', options: ['A', 'A', ' A '] }]
    })
    expect(dupes.ok).toBe(true)
    if (!dupes.ok) return
    expect(dupes.form.questions[0]).toEqual({ id: 'q1', prompt: 'Dupes?', type: 'text' })

    const blanks = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'Blanks?', type: 'multi', options: ['', '   '] }]
    })
    expect(blanks.ok).toBe(true)
    if (!blanks.ok) return
    expect(blanks.form.questions[0]!.type).toBe('text')

    const multiOne = normalizeAskQuestionArgs({
      questions: [{ id: 'q1', prompt: 'One?', type: 'multi', options: ['A'], allowCustom: true }]
    })
    expect(multiOne.ok).toBe(true)
    if (!multiOne.ok) return
    expect(multiOne.form.questions[0]).toEqual({ id: 'q1', prompt: 'One?', type: 'text' })
  })

  it('coerces a legacy single-option question to text', () => {
    const result = normalizeAskQuestionArgs({ question: 'Only?', options: ['A'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.form.questions[0]).toEqual({ id: 'q1', prompt: 'Only?', type: 'text' })
  })
})

describe('formatQuestionAnswers', () => {
  it('formats a single value with its prompt, so it reads on its own after a fold', () => {
    expect(
      formatQuestionAnswers(
        { questions: [{ id: 'q1', prompt: 'Pick?', type: 'single', options: ['A', 'B'] }] },
        [{ questionId: 'q1', values: ['A'] }]
      )
    ).toBe('User answered:\n- Pick?: A')
  })

  it('puts a multi-line prompt on one line and indents a multi-line answer', () => {
    expect(
      formatQuestionAnswers(
        { questions: [{ id: 'q1', prompt: 'Which\n- option?', type: 'text' }] },
        [{ questionId: 'q1', values: ['Two things:\n- a\n- b'] }]
      )
    ).toBe('User answered:\n- Which - option?: Two things:\n  - a\n  - b')
  })

  it('joins several values of one question on its line', () => {
    expect(
      formatQuestionAnswers(
        { questions: [{ id: 'q1', prompt: 'Which?', type: 'multi', options: ['A', 'B', 'C'] }] },
        [{ questionId: 'q1', values: ['A', 'C'] }]
      )
    ).toBe('User answered:\n- Which?: A, C')
  })

  it('returns the skip guidance when no question has a value', () => {
    expect(
      formatQuestionAnswers({ questions: [{ id: 'q1', prompt: 'Pick?', type: 'text' }] }, [
        { questionId: 'q1', values: ['  '] }
      ])
    ).toBe(ASK_QUESTION_NO_ANSWER_GUIDANCE)
  })
})

describe('askQuestionSummary', () => {
  it('is one line and marks a cut with an ellipsis', () => {
    const summary = askQuestionSummary({
      questions: [{ id: 'q1', prompt: `First line\nsecond ${'x'.repeat(200)}`, type: 'text' }]
    })
    expect(summary).not.toContain('\n')
    expect(summary).toHaveLength(120)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('sanitizeQuestionAnswers', () => {
  const questions: AgentQuestionItem[] = [
    { id: 'pick', prompt: 'Pick?', type: 'single', options: ['A', 'B'] },
    { id: 'other', prompt: 'Other?', type: 'single', options: ['A', 'B'], allowCustom: true },
    { id: 'many', prompt: 'Many?', type: 'multi', options: ['A', 'B', 'C'] },
    { id: 'yn', prompt: 'OK?', type: 'boolean' },
    { id: 'free', prompt: 'Notes?', type: 'text' }
  ]

  it('drops a choice outside the options unless custom answers are allowed', () => {
    expect(
      sanitizeQuestionAnswers(questions, [
        { questionId: 'pick', values: ['Z'] },
        { questionId: 'other', values: ['Z'] }
      ])
    ).toEqual([{ questionId: 'other', values: ['Z'] }])
  })

  it('folds a boolean to Yes/No and drops anything else', () => {
    expect(
      sanitizeQuestionAnswers(questions, [{ questionId: 'yn', values: ['true'] }])
    ).toEqual([{ questionId: 'yn', values: ['Yes'] }])
    expect(sanitizeQuestionAnswers(questions, [{ questionId: 'yn', values: ['maybe'] }])).toEqual(
      []
    )
  })

  it('dedupes values, keeps one per non-multi question, and ignores a repeated id', () => {
    expect(
      sanitizeQuestionAnswers(questions, [
        { questionId: 'many', values: ['A', 'A', 'C'] },
        { questionId: 'free', values: ['one', 'two'] },
        { questionId: 'free', values: ['three'] }
      ])
    ).toEqual([
      { questionId: 'many', values: ['A', 'C'] },
      { questionId: 'free', values: ['one'] }
    ])
  })

  it('caps a long text answer', () => {
    const [answer] = sanitizeQuestionAnswers(questions, [
      { questionId: 'free', values: ['x'.repeat(AGENT_QUESTION_MAX_ANSWER_CHARS + 50)] }
    ])
    expect(answer!.values[0]).toHaveLength(AGENT_QUESTION_MAX_ANSWER_CHARS)
    expect(answer!.values[0]!.endsWith('…')).toBe(true)
  })
})

describe('normalizeAskQuestionArgs limits', () => {
  it('rejects too many questions, too many options, and over-long text', () => {
    const tooMany = normalizeAskQuestionArgs({
      questions: Array.from({ length: AGENT_QUESTION_MAX_ITEMS + 1 }, (_, i) => ({
        id: `q${i}`,
        prompt: `Q${i}?`,
        type: 'text'
      }))
    })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error).toContain(`limit is ${AGENT_QUESTION_MAX_ITEMS}`)

    const options = normalizeAskQuestionArgs({
      question: 'Pick?',
      options: Array.from({ length: AGENT_QUESTION_MAX_OPTIONS + 1 }, (_, i) => `O${i}`)
    })
    expect(options.ok).toBe(false)

    const longPrompt = normalizeAskQuestionArgs({
      questions: [{ prompt: 'x'.repeat(AGENT_QUESTION_MAX_PROMPT_CHARS + 1), type: 'text' }]
    })
    expect(longPrompt.ok).toBe(false)

    const longTitle = normalizeAskQuestionArgs({
      title: 't'.repeat(AGENT_QUESTION_MAX_TITLE_CHARS + 1),
      question: 'Pick?'
    })
    expect(longTitle.ok).toBe(false)
  })

  it('formats multi-question answers with prompts', () => {
    expect(
      formatQuestionAnswers(
        {
          questions: [
            { id: 'a', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'] },
            { id: 'b', prompt: 'Continue?', type: 'boolean' }
          ]
        },
        [
          { questionId: 'a', values: ['Ask'] },
          { questionId: 'b', values: ['Yes'] }
        ]
      )
    ).toBe('User answered:\n- Mode?: Ask\n- Continue?: Yes')
  })
})
