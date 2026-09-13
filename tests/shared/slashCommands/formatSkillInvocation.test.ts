import { describe, expect, it } from 'vitest'
import { formatGoalInvocation } from '@shared/goalRuntime'
import {
  formatSkillInvocation,
  formatWorkspaceCommand,
  formatMcpToolInvocation,
  findActiveSlashToken,
  parseSlashSubmit,
  parseSkillInvocation,
  parseMcpToolInvocation,
  skillInvocationDisplayText,
  skillInvocationEditDraft,
  SKILL_BODY_STUB,
  stubSkillInvocationContent,
  stubPastSkillInvocationsInMessages,
  isSkillInvocationBodyStubbed,
  userMessageDisplayText,
  runGoalFromUserText,
  scrubPathsFromGoalText,
  findAbsolutePathsInText,
  outsideWorkspacePathGuidance,
  resolveSlashCommandForSubmit
} from '../../../src/shared/slashCommands'

describe('formatSkillInvocation', () => {
  it('wraps skill body and trailing user text', () => {
    const msg = formatSkillInvocation('code-review', 'Do a review.', 'check auth')
    expect(msg).toContain('[Skill: code-review]')
    expect(msg).toContain('<skill instructions>')
    expect(msg).toContain('Do a review.')
    expect(msg).toContain('User request:')
    expect(msg).toContain('check auth')
  })

  it('uses placeholder when trailing text is empty', () => {
    const msg = formatSkillInvocation('docs', 'Write docs.')
    expect(msg).toContain('(no additional instructions)')
  })
})

describe('parseSkillInvocation', () => {
  it('round-trips formatSkillInvocation', () => {
    const msg = formatSkillInvocation('code-review', 'Do a review.\nBe thorough.', 'check auth')
    expect(parseSkillInvocation(msg)).toEqual({
      skillName: 'code-review',
      body: 'Do a review.\nBe thorough.',
      userRequest: 'check auth'
    })
  })

  it('treats placeholder as empty user request', () => {
    const msg = formatSkillInvocation('docs', 'Write docs.')
    expect(parseSkillInvocation(msg)?.userRequest).toBe('')
  })

  it('keeps the real user request when the body documents the closer template', () => {
    const body = [
      'Document the wrapper:',
      '</skill instructions>',
      '',
      'User request:',
      'do not treat this as the request'
    ].join('\n')
    const msg = formatSkillInvocation('docs', body, 'real request')
    const parsed = parseSkillInvocation(msg)
    expect(parsed?.skillName).toBe('docs')
    expect(parsed?.userRequest).toBe('real request')
    expect(parsed?.body).toContain('&lt;/skill instructions>')
    expect(parsed?.body).not.toMatch(/<\/skill instructions>/)
  })

  it('returns null for ordinary messages', () => {
    expect(parseSkillInvocation('hello')).toBeNull()
    expect(parseSkillInvocation('/code-review check')).toBeNull()
  })
})

describe('skillInvocationDisplayText', () => {
  it('shows slash name and user request without body', () => {
    const parsed = parseSkillInvocation(
      formatSkillInvocation('code-review', 'LONG BODY', 'focus auth')
    )!
    expect(skillInvocationDisplayText(parsed)).toBe('/code-review\n\nfocus auth')
    expect(skillInvocationDisplayText(parsed)).not.toContain('LONG BODY')
  })

  it('omits empty request placeholder', () => {
    const parsed = parseSkillInvocation(formatSkillInvocation('docs', 'body'))!
    expect(skillInvocationDisplayText(parsed)).toBe('/docs')
  })
})

describe('skillInvocationEditDraft', () => {
  it('restores slash form for re-resolve', () => {
    const parsed = parseSkillInvocation(
      formatSkillInvocation('code-review', 'body', 'check auth')
    )!
    expect(skillInvocationEditDraft(parsed)).toBe('/code-review check auth')
  })

  it('still rehydrates after body stub', () => {
    const full = formatSkillInvocation('code-review', 'LONG BODY', 'check auth')
    const stubbed = stubSkillInvocationContent(full)!
    const parsed = parseSkillInvocation(stubbed)!
    expect(isSkillInvocationBodyStubbed(parsed.body)).toBe(true)
    expect(skillInvocationEditDraft(parsed)).toBe('/code-review check auth')
  })
})

describe('stubPastSkillInvocationsInMessages', () => {
  it('keeps full body on the open (last) skill turn', () => {
    const full = formatSkillInvocation('docs', 'LONG BODY', 'write')
    const { messages, stubbedCount } = stubPastSkillInvocationsInMessages([
      { role: 'user', content: full }
    ])
    expect(stubbedCount).toBe(0)
    expect(messages[0]?.content).toContain('LONG BODY')
  })

  it('stubs skill body once a follow-up message exists', () => {
    const full = formatSkillInvocation('docs', 'LONG BODY', 'write')
    const { messages, stubbedCount } = stubPastSkillInvocationsInMessages([
      { role: 'user', content: full },
      { role: 'assistant', content: 'ok' }
    ])
    expect(stubbedCount).toBe(1)
    expect(String(messages[0]?.content)).not.toContain('LONG BODY')
    expect(String(messages[0]?.content)).toContain(SKILL_BODY_STUB)
    const parsed = parseSkillInvocation(String(messages[0]?.content))!
    expect(skillInvocationEditDraft(parsed)).toBe('/docs write')
  })

  it('is idempotent — a second pass over stubbed history stubs nothing new', () => {
    // The agent loop's per-step disk rewrite gate relies on this: once a body
    // is stubbed, later passes must report stubbedCount 0 so the transcript
    // is not re-read and rewritten on every step.
    const full = formatSkillInvocation('docs', 'LONG BODY', 'write')
    const first = stubPastSkillInvocationsInMessages([
      { role: 'user', content: full },
      { role: 'tool', toolName: 'Skill', toolCallId: 's1', content: 'BODY' },
      { role: 'assistant', content: 'ok' }
    ])
    expect(first.stubbedCount).toBeGreaterThan(0)
    const second = stubPastSkillInvocationsInMessages(first.messages)
    expect(second.stubbedCount).toBe(0)
    expect(second.messages).toEqual(first.messages)
  })

  it('stubs earlier Skill tool results and keeps the latest body', () => {
    const reviewBody = [
      '# Skill: review-code',
      '',
      'Review the diff before editing. Lead with severity, then a concrete patch.',
      'Do not rewrite unrelated files in the same turn.'
    ].join('\n')
    const testsBody = [
      '# Skill: write-tests',
      '',
      'Add vitest coverage for the changed auth login path.',
      'Use the real handler names from src/main/ipc/register.ts.'
    ].join('\n')
    const { messages, stubbedCount } = stubPastSkillInvocationsInMessages([
      { role: 'user', content: 'Review auth then add tests' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 's1', name: 'Skill', arguments: '{"name":"review-code"}' }]
      },
      { role: 'tool', toolName: 'Skill', toolCallId: 's1', content: reviewBody },
      { role: 'assistant', content: 'Review done. Adding tests next.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 's2', name: 'Skill', arguments: '{"name":"write-tests"}' }]
      },
      { role: 'tool', toolName: 'Skill', toolCallId: 's2', content: testsBody },
      { role: 'assistant', content: 'Writing the login tests now.' }
    ])
    expect(stubbedCount).toBe(1)
    expect(String(messages[2]?.content)).toBe(SKILL_BODY_STUB)
    expect(String(messages[2]?.content)).not.toContain('Lead with severity')
    expect(String(messages[5]?.content)).toContain(
      'Add vitest coverage for the changed auth login path'
    )
    expect(String(messages[5]?.content)).not.toBe(SKILL_BODY_STUB)
  })

  it('does not stub a lone Skill tool result still in use this step', () => {
    const body = '# Skill: review-code\n\nReview the diff before editing.'
    const { messages, stubbedCount } = stubPastSkillInvocationsInMessages([
      { role: 'user', content: 'review src/main/agent/loop.ts' },
      { role: 'tool', toolName: 'Skill', toolCallId: 's1', content: body },
      { role: 'assistant', content: 'Starting the review.' }
    ])
    expect(stubbedCount).toBe(0)
    expect(String(messages[1]?.content)).toContain('Review the diff before editing')
  })

  it('leaves non-Skill tool results intact', () => {
    const fileBody =
      'export function login(req: Request): Session {\n  return createSession(req)\n}\n'
    const { messages, stubbedCount } = stubPastSkillInvocationsInMessages([
      { role: 'tool', toolName: 'read', toolCallId: 'r1', content: fileBody },
      {
        role: 'tool',
        toolName: 'Skill',
        toolCallId: 's1',
        content: '# Skill: review-code\n\nReview auth.'
      },
      { role: 'assistant', content: 'ok' }
    ])
    expect(stubbedCount).toBe(0)
    expect(String(messages[0]?.content)).toContain('export function login')
    expect(String(messages[1]?.content)).toContain('Review auth.')
  })
})

describe('userMessageDisplayText', () => {
  it('collapses skill injections and passes through other text', () => {
    const skill = formatSkillInvocation('docs', 'body', 'write README')
    expect(userMessageDisplayText(skill)).toBe('/docs\n\nwrite README')
    expect(userMessageDisplayText('plain')).toBe('plain')
  })

  it('collapses MCP tool invocations', () => {
    const mcp = formatMcpToolInvocation('docs', 'search', 'desc', 'find auth')
    expect(userMessageDisplayText(mcp)).toBe('/docs-search\n\nfind auth')
  })
})

describe('runGoalFromUserText', () => {
  it('uses the /goal objective as the sidebar title', () => {
    expect(runGoalFromUserText(formatGoalInvocation('fix flaky tests'))).toBe('fix flaky tests')
  })

  it('uses skill display text for goals', () => {
    const skill = formatSkillInvocation('accessibility', 'LONG BODY', '')
    expect(runGoalFromUserText(skill)).toBe('/accessibility')
    expect(runGoalFromUserText(skill)).not.toContain('<skill instructions>')
  })

  it('recovers when skill body truncates the closer', () => {
    const truncated =
      '[Skill: accessibility]\n\n<skill instructions>\n# Accessibility\n\n## Instructions\n1. Prefer semantic HTML'
    expect(runGoalFromUserText(truncated)).toBe('/accessibility')
  })

  it('scrubs absolute paths from the goal line', () => {
    const goal = runGoalFromUserText(
      'Review "C:\\Users\\admin\\Downloads\\FORGET Loop Engineering.txt" please'
    )
    expect(goal).not.toMatch(/[A-Za-z]:\\/)
    expect(goal).toContain('Review')
    expect(goal).toContain('please')
    expect(goal).not.toContain('Downloads')
  })

  it('becomes chat when the message is only an absolute path', () => {
    expect(
      runGoalFromUserText('"C:\\Users\\admin\\Downloads\\FORGET Loop Engineering.txt"')
    ).toBe('chat')
    expect(scrubPathsFromGoalText('C:\\Users\\admin\\Downloads\\a.txt')).toBe('chat')
  })
})

describe('findAbsolutePathsInText', () => {
  it('detects Windows absolute paths', () => {
    const paths = findAbsolutePathsInText(
      '"C:\\Users\\admin\\Downloads\\FORGET Loop Engineering.txt"'
    )
    expect(paths.some((p) => p.includes('Downloads'))).toBe(true)
  })

  it('builds outside-workspace guidance', () => {
    const tip = outsideWorkspacePathGuidance(['C:\\Users\\admin\\Downloads\\a.txt'])
    expect(tip).toContain('outside the workspace sandbox')
    expect(tip).toContain('Copy or move')
  })
})

describe('parseMcpToolInvocation', () => {
  it('round-trips formatMcpToolInvocation', () => {
    const msg = formatMcpToolInvocation('srv', 'tool', 'A tool', 'do it')
    expect(parseMcpToolInvocation(msg)).toEqual({
      serverId: 'srv',
      toolName: 'tool',
      userRequest: 'do it'
    })
  })

  it('treats infer placeholder as empty request', () => {
    const msg = formatMcpToolInvocation('srv', 'tool', '')
    expect(parseMcpToolInvocation(msg)?.userRequest).toBe('')
  })

  it('round-trips multi-line tool descriptions', () => {
    const msg = formatMcpToolInvocation('srv', 'search', 'Line one\nLine two', 'find auth')
    expect(parseMcpToolInvocation(msg)).toEqual({
      serverId: 'srv',
      toolName: 'search',
      userRequest: 'find auth'
    })
  })

  it('keeps the real goal when the description mentions the goal marker', () => {
    const desc = 'Mentions\nGoal / arguments hint:\nfake'
    const msg = formatMcpToolInvocation('srv', 'tool', desc, 'real goal')
    expect(parseMcpToolInvocation(msg)?.userRequest).toBe('real goal')
  })
})

describe('resolveSlashCommandForSubmit', () => {
  const commands = [
    {
      id: 'skill:code-review',
      trigger: 'code-review',
      label: 'code-review',
      description: 'Review'
    },
    {
      id: 'builtin:compact',
      trigger: 'compact',
      label: 'Compact',
      description: 'Summarize'
    }
  ]

  it('exact-matches full triggers', () => {
    expect(resolveSlashCommandForSubmit('code-review', commands)?.id).toBe('skill:code-review')
  })

  it('prefers active command when typed trigger is a prefix', () => {
    const active = commands[0]!
    expect(resolveSlashCommandForSubmit('cod', commands, active)?.id).toBe('skill:code-review')
  })

  it('uses top fuzzy prefix hit without active command', () => {
    expect(resolveSlashCommandForSubmit('cod', commands)?.id).toBe('skill:code-review')
  })

  it('returns null when typed trigger is not a prefix of any command', () => {
    expect(resolveSlashCommandForSubmit('zzzz', commands)).toBeNull()
  })
})

describe('formatWorkspaceCommand', () => {
  it('replaces {{input}} placeholders', () => {
    expect(formatWorkspaceCommand('Run {{input}} now', 'tests')).toBe('Run tests now')
  })

  it('appends trailing text when no placeholder', () => {
    expect(formatWorkspaceCommand('Do the thing', 'extra')).toBe('Do the thing\n\nextra')
  })
})

describe('formatMcpToolInvocation', () => {
  it('names the MCP tool and server', () => {
    const msg = formatMcpToolInvocation('fetch', 'fetch', 'HTTP GET', 'https://example.com')
    expect(msg).toContain('`fetch`')
    expect(msg).toContain('`fetch`')
    expect(msg).toContain('https://example.com')
  })
})

describe('findActiveSlashToken', () => {
  it('detects token at start of draft', () => {
    const token = findActiveSlashToken('/cod', 4)
    expect(token).toEqual({
      start: 0,
      end: 4,
      trigger: 'cod',
      trailingText: '',
      query: 'cod'
    })
  })

  it('closes once cursor moves past trailing space', () => {
    expect(findActiveSlashToken('/compact check', 14)).toBeNull()
  })

  it('stays active while caret is in the trigger', () => {
    const token = findActiveSlashToken('/compact', 4)
    expect(token?.trigger).toBe('compact')
    expect(token?.query).toBe('compact')
  })
})

describe('parseSlashSubmit', () => {
  it('parses trigger and trailing args', () => {
    expect(parseSlashSubmit('/code-review look at auth')).toEqual({
      trigger: 'code-review',
      trailingText: 'look at auth'
    })
  })

  it('returns null for non-slash text', () => {
    expect(parseSlashSubmit('hello')).toBeNull()
  })
})
