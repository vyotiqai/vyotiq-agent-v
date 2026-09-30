import { describe, expect, it } from 'vitest'
import { AgentQuestionRequestSchema } from '@shared/ipc'
import { elicitationContent, elicitationForm } from '@main/agent/mcp/elicitation'

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Repository name', minLength: 2 },
    email: { type: 'string', title: 'Contact', format: 'email' },
    stars: { type: 'integer', title: 'Minimum stars', minimum: 0, maximum: 100 },
    private: { type: 'boolean', title: 'Private' },
    license: { type: 'string', title: 'License', oneOf: [{ const: 'mit', title: 'MIT' }, { const: 'apache-2.0', title: 'Apache 2.0' }] },
    labels: { type: 'array', title: 'Labels', items: { anyOf: [{ const: 'bug', title: 'Bug' }, { const: 'docs', title: 'Docs' }, { const: 'ci', title: 'CI' }] }, maxItems: 2 },
    legacy: { type: 'string', title: 'Region', enum: ['eu', 'us'], enumNames: ['Europe', 'United States'] }
  },
  required: ['name', 'license']
}

function form() {
  const res = elicitationForm('GitHub', 'Create the repository with these details?', SCHEMA)
  if (!res.ok) throw new Error(res.reason)
  return res.form
}

describe('MCP elicitation as a question card', () => {
  it('turns every field kind the protocol allows into a card item the question schema accepts', () => {
    const f = form()
    expect(f.title).toBe('GitHub asks')
    expect(f.questions.map((q) => q.type)).toEqual(['text', 'text', 'text', 'boolean', 'single', 'multi', 'single'])
    expect(f.questions[0]!.prompt).toBe('Create the repository with these details?\n\nRepository name')
    expect(f.questions[1]!.prompt).toBe('Contact (an email address) (optional)')
    expect(f.questions[2]!.prompt).toBe('Minimum stars (a whole number from 0 to 100) (optional)')
    expect(f.questions[4]!.options).toEqual(['MIT', 'Apache 2.0'])
    expect(f.questions[6]!.options).toEqual(['Europe', 'United States'])
    // What main sends the renderer must pass the same schema the card validates.
    expect(AgentQuestionRequestSchema.safeParse({ requestId: 'r', runId: 'run', toolCallId: 't', title: f.title, questions: f.questions }).success).toBe(true)
  })

  it('returns typed values under the server’s keys: numbers, booleans, choice values not labels', () => {
    const res = elicitationContent(form(), [
      { questionId: 'f0', values: ['agent-v'] },
      { questionId: 'f1', values: [] },
      { questionId: 'f2', values: ['42'] },
      { questionId: 'f3', values: ['No'] },
      { questionId: 'f4', values: ['Apache 2.0'] },
      { questionId: 'f5', values: ['Bug', 'CI'] },
      { questionId: 'f6', values: ['Europe'] }
    ])
    expect(res).toEqual({
      action: 'accept',
      content: { name: 'agent-v', stars: 42, private: false, license: 'apache-2.0', labels: ['bug', 'ci'], legacy: 'eu' }
    })
  })

  it('Skip declines; a missing or malformed value asks again with the reason', () => {
    const f = form()
    expect(elicitationContent(f, f.questions.map((q) => ({ questionId: q.id, values: [] })))).toEqual({ action: 'decline' })
    expect(elicitationContent(f, [{ questionId: 'f0', values: ['agent-v'] }])).toEqual({ action: 'retry', problem: 'License is needed' })
    const base = [
      { questionId: 'f0', values: ['agent-v'] },
      { questionId: 'f4', values: ['MIT'] }
    ]
    expect(elicitationContent(f, [...base, { questionId: 'f2', values: ['4.5'] }])).toEqual({ action: 'retry', problem: 'Minimum stars should be a whole number' })
    expect(elicitationContent(f, [...base, { questionId: 'f2', values: ['101'] }])).toEqual({ action: 'retry', problem: 'Minimum stars should be at most 100' })
    expect(elicitationContent(f, [...base, { questionId: 'f1', values: ['not-an-email'] }])).toEqual({ action: 'retry', problem: 'Contact should be an email address' })
    expect(elicitationContent(f, [...base, { questionId: 'f5', values: ['Bug', 'Docs', 'CI'] }])).toEqual({ action: 'retry', problem: 'pick at most 2 for Labels' })
    expect(elicitationContent(f, [{ questionId: 'f0', values: ['a'] }, { questionId: 'f4', values: ['MIT'] }])).toEqual({ action: 'retry', problem: 'Repository name should be at least 2 characters' })
  })

  it('refuses forms it cannot show honestly', () => {
    expect(elicitationForm('S', 'm', { type: 'object', properties: {} })).toEqual({ ok: false, reason: 'asks for nothing' })
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, { type: 'string' }]))
    expect(elicitationForm('S', 'm', { type: 'object', properties: many })).toMatchObject({ ok: false })
    expect(elicitationForm('S', 'm', { type: 'object', properties: { o: { type: 'object' } } })).toMatchObject({ ok: false })
  })
})
