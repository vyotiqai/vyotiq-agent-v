import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import {
  extractFoldFacts,
  parseContractGoal,
  parseContractDoneWhen,
  extractUserConstraints,
  collectPathsFromText,
  isPlausibleWorkspaceFilePath
} from '@main/agent/context/foldFacts'
import type { TodoItem } from '@main/agent/tools/todo'

function user(text: string): ChatMessage {
  return { role: 'user', content: text }
}

function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  ok = true
): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }]
  }
}

function toolResult(callId: string, name: string, content: string, ok = true): ChatMessage {
  return { role: 'tool', content, toolCallId: callId, toolName: name, ok }
}

describe('extractFoldFacts', () => {
  it('collects written files from successful write tool calls', () => {
    const msgs: ChatMessage[] = [
      toolCall('c1', 'edit', { path: 'src/app.ts', contents: 'x' }),
      toolResult('c1', 'edit', 'Created src/app.ts', true)
    ]
    const facts = extractFoldFacts(msgs)
    expect(facts.wroteFiles).toContain('src/app.ts')
    expect(facts.files).toContain('src/app.ts')
  })

  it('does not count writes whose tool result failed', () => {
    const msgs: ChatMessage[] = [
      toolCall('c1', 'edit', { path: 'src/app.ts', contents: 'x' }),
      toolResult('c1', 'edit', 'error', false)
    ]
    const facts = extractFoldFacts(msgs)
    expect(facts.wroteFiles).not.toContain('src/app.ts')
  })

  it('collects inspected files from read/grep tool calls', () => {
    const msgs: ChatMessage[] = [
      toolCall('c1', 'read', { path: 'docs/readme.md' }),
      toolResult('c1', 'read', 'ok', true),
      toolCall('c2', 'grep', { pattern: 'foo', path: 'src/search.ts' }),
      toolResult('c2', 'grep', 'ok', true)
    ]
    const facts = extractFoldFacts(msgs)
    expect(facts.files).toContain('docs/readme.md')
    expect(facts.files).toContain('src/search.ts')
  })

  it('pulls paths from prose backticks and dir/file tokens', () => {
    const msgs: ChatMessage[] = [user('Look at `src/util.ts` and config/settings.json')]
    const facts = extractFoldFacts(msgs)
    expect(facts.files).toContain('src/util.ts')
    expect(facts.files).toContain('config/settings.json')
  })

  it('collects open todos from todo_write results', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'First task', status: 'pending' },
      { id: '2', content: 'Done task', status: 'completed' }
    ]
    const facts = extractFoldFacts([], { todos })
    expect(facts.todos).toEqual(['First task'])
  })

  it('parses contract goal and done-when', () => {
    const contract = [
      '## Goal',
      'Build a robust CSV importer',
      '',
      '## Done when',
      '- CSV parsing passes edge cases',
      '- (none)',
      ''
    ].join('\n')
    const facts = extractFoldFacts([], { contract })
    expect(facts.contractGoal).toBe('Build a robust CSV importer')
    expect(facts.doneWhen).toEqual(['CSV parsing passes edge cases'])
  })

  it('extracts user constraints', () => {
    const msgs: ChatMessage[] = [
      user('Do not use global state. Always keep diffs minimal.')
    ]
    const facts = extractFoldFacts(msgs)
    expect(facts.constraints?.some((c) => /do not use global state/i.test(c))).toBe(true)
    expect(facts.constraints?.some((c) => /keep diffs minimal/i.test(c))).toBe(true)
  })
})

describe('foldFacts helpers', () => {
  it('parseContractGoal ignores generic stubs', () => {
    expect(parseContractGoal('## Goal\nchat\n')).toBeUndefined()
    expect(parseContractGoal('## Goal\nship the feature\n')).toBe('ship the feature')
  })

  it('parseContractDoneWhen skips boilerplate', () => {
    const contract = [
      '## Done when',
      '- goal above is satisfied',
      '- real condition'
    ].join('\n')
    expect(parseContractDoneWhen(contract)).toEqual(['real condition'])
  })

  it('extractUserConstraints filters non-constraint sentences', () => {
    const msgs: ChatMessage[] = [user('Hello there. Never commit secrets.')]
    const out = extractUserConstraints(msgs)
    expect(out.some((c) => /never commit secrets/i.test(c))).toBe(true)
    expect(out.some((c) => /hello there/i.test(c))).toBe(false)
  })

  it('collectPathsFromText dedups case-insensitively', () => {
    const out = collectPathsFromText('`src/A.ts` and src/a.ts')
    expect(out.filter((p) => p === 'src/A.ts')).toHaveLength(1)
  })

  it('isPlausibleWorkspaceFilePath rejects junk', () => {
    expect(isPlausibleWorkspaceFilePath('src/a.ts')).toBe(true)
    expect(isPlausibleWorkspaceFilePath('*.ts')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('https://x.com')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('process.env')).toBe(false)
  })
})
