import { describe, expect, it } from 'vitest'
import {
  askQuestionPromptEnd,
  extractAskQuestionDecisions,
  parseAskQuestionResult,
  loopHintForRetainedDecisions,
  mergeCompactionFocus
} from '@main/agent/context/retainedDecisions'
import type { ChatMessage } from '@shared/ipc'
import {
  ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE,
  ASK_QUESTION_NO_ANSWER_GUIDANCE,
  ASK_QUESTION_SUPERSEDED_GUIDANCE
} from '@shared/utils/agentQuestionForm'

const ASK_QUESTION_MSG_6 = [
  'User answered:',
  '- Primary language/runtime for the agent core?: Not sure \u2014 recommend one',
  '- Primary interface / deployment surface?: Not sure \u2014 recommend one',
  '- LLM provider strategy?: Provider-agnostic (OpenAI, Anthropic, local/self-host, etc.) via a thin adapter',
  '- Is this an original agent framework (build core from scratch) or a thin layer on an existing agent framework/sdk?: Original core + MCP for external connections'
].join('\n')

const ASK_QUESTION_MSG_11 = [
  'User answered:',
  '- MCP transports to implement in phase P5?: Both stdio and HTTP/SSE transports at P5',
  '- Confirmation UX for destructive tools?: Both: interactive CLI prompt for CLI users AND a programmable approval callback for library integration',
  '- Auth for external MCP servers at P5?: Yes \u2014 token/header auth support at P5',
  '- Observability: pino only now, or add OpenTelemetry?: Include minimal structured logging/OTel from P0'
].join('\n')

describe('retainedDecisions', () => {
  it('extracts User answered lines from ask_question tool results', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'q1',
        toolName: 'ask_question',
        ok: true,
        content: 'User answered: Use PostgreSQL for persistence'
      },
      {
        role: 'tool',
        toolCallId: 'q2',
        toolName: 'ask_question',
        ok: true,
        content: 'User answered: Ship the API first'
      }
    ]
    expect(extractAskQuestionDecisions(messages)).toEqual([
      'Use PostgreSQL for persistence',
      'Ship the API first'
    ])
  })

  it('dedupes identical decisions', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'q1',
        toolName: 'ask_question',
        ok: true,
        content: 'User answered: Same choice'
      },
      {
        role: 'tool',
        toolCallId: 'q2',
        toolName: 'ask_question',
        ok: true,
        content: 'User answered: Same choice'
      }
    ]
    expect(extractAskQuestionDecisions(messages)).toEqual(['Same choice'])
  })

  it('merges operator focus with retained decisions for summarizer focus', () => {
    const merged = mergeCompactionFocus('Keep auth details', ['Use JWT'])
    expect(merged).toContain('Preserve these user decisions')
    expect(merged).toContain('Use JWT')
    expect(merged).toContain('Keep auth details')
  })

  it('returns undefined when focus and decisions are empty', () => {
    expect(mergeCompactionFocus(undefined, [])).toBeUndefined()
    expect(loopHintForRetainedDecisions([])).toBeUndefined()
  })

  it('builds loop hint for retained decisions', () => {
    const hint = loopHintForRetainedDecisions(['Use PostgreSQL'])
    expect(hint).toMatch(/do not re-ask/i)
    expect(hint).toContain('Use PostgreSQL')
  })

  it('parses every prompt/answer bullet from a User answered block', () => {
    expect(parseAskQuestionResult(ASK_QUESTION_MSG_6)).toEqual([
      'Primary language/runtime for the agent core?: Not sure \u2014 recommend one',
      'Primary interface / deployment surface?: Not sure \u2014 recommend one',
      'LLM provider strategy?: Provider-agnostic (OpenAI, Anthropic, local/self-host, etc.) via a thin adapter',
      'Is this an original agent framework (build core from scratch) or a thin layer on an existing agent framework/sdk?: Original core + MCP for external connections'
    ])
    expect(parseAskQuestionResult(ASK_QUESTION_MSG_11)).toHaveLength(4)
    expect(parseAskQuestionResult(ASK_QUESTION_MSG_11)[0]).toBe(
      'MCP transports to implement in phase P5?: Both stdio and HTTP/SSE transports at P5'
    )
  })

  it('extracts all ask_question bullets from the two recorded tool results', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'q1',
        toolName: 'ask_question',
        ok: true,
        content: ASK_QUESTION_MSG_6
      },
      {
        role: 'tool',
        toolCallId: 'q2',
        toolName: 'ask_question',
        ok: true,
        content: ASK_QUESTION_MSG_11
      }
    ]
    const decisions = extractAskQuestionDecisions(messages)
    expect(decisions).toHaveLength(8)
    expect(decisions).toContain(
      'Primary language/runtime for the agent core?: Not sure \u2014 recommend one'
    )
    expect(decisions).toContain(
      'MCP transports to implement in phase P5?: Both stdio and HTTP/SSE transports at P5'
    )
    expect(decisions).toContain(
      'Observability: pino only now, or add OpenTelemetry?: Include minimal structured logging/OTel from P0'
    )
  })
})

describe('retainedDecisions: what counts as a decision', () => {
  const tool = (content: string, ok = true): ChatMessage => ({
    role: 'tool',
    toolCallId: `t-${content.length}`,
    toolName: 'ask_question',
    ok,
    content
  })

  it('never keeps skips, supersedes, failures or stubs', () => {
    const messages = [
      tool(ASK_QUESTION_NO_ANSWER_GUIDANCE),
      tool(ASK_QUESTION_SUPERSEDED_GUIDANCE),
      tool(ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE),
      tool('ask_question requires an app window but none is listening. Retry.', false),
      tool('Interrupted', false),
      tool('Cancelled', false),
      // A failed call whose text happens to look like an answer still is not one.
      tool('User answered:\n- Fake?: yes', false)
    ]
    expect(extractAskQuestionDecisions(messages)).toEqual([])
  })

  it('drops (no answer) bullets from a multi-question form', () => {
    expect(parseAskQuestionResult('User answered:\n- Which DB?: Postgres\n- Region?: (no answer)')).toEqual(
      ['Which DB?: Postgres']
    )
  })

  it('keeps an indented multi-line answer in its own bullet', () => {
    expect(
      parseAskQuestionResult('User answered:\n- What should change?: Two things:\n  - the header\n  - the footer')
    ).toEqual(['What should change?: Two things: - the header - the footer'])
  })

  it('keeps an older same-line answer whole, bullets included', () => {
    expect(parseAskQuestionResult('User answered: Do these:\n- x\n- y')).toEqual(['Do these: - x - y'])
  })

  it('clips a long prompt before the answer', () => {
    const [decision] = parseAskQuestionResult(`User answered:\n- ${'Why '.repeat(80)}?: Postgres`)
    expect(decision!.length).toBeLessThanOrEqual(240)
    expect(decision).toMatch(/^Why Why .*…: Postgres$/)
  })

  it('splits prompt from answer at the first "?: ", never inside the answer', () => {
    const decision = 'Which regex?: use (?:a|b): then more'
    expect(decision.slice(0, askQuestionPromptEnd(decision))).toBe('Which regex?')
  })

  it('keeps the newest decisions in the loop hint', () => {
    const decisions = Array.from({ length: 10 }, (_, i) => `Q${i}?: A${i}`)
    const hint = loopHintForRetainedDecisions(decisions)!
    expect(hint).toContain('Q9?: A9')
    expect(hint).not.toContain('Q0?: A0')
    expect(hint).toContain('(+2 earlier)')
  })
})
