import { describe, expect, it } from 'vitest'
import { normalizeTrigger, triggerKey, fuzzyMatchCommands } from '../../../src/shared/slashCommands'

describe('normalizeTrigger', () => {
  it('strips leading slashes and lowercases', () => {
    expect(normalizeTrigger('/Code-Review')).toBe('code-review')
    expect(normalizeTrigger('///compact')).toBe('compact')
  })

  it('collapses underscores and spaces to hyphens', () => {
    expect(normalizeTrigger('code_review')).toBe('code-review')
    expect(normalizeTrigger('code review')).toBe('code-review')
  })
})

describe('triggerKey', () => {
  it('strips non-alphanumeric for equality', () => {
    expect(triggerKey('code-review')).toBe('codereview')
    expect(triggerKey('code_review')).toBe('codereview')
  })
})

describe('fuzzyMatchCommands', () => {
  const items = [
    { id: '1', trigger: 'code-review', label: 'Code review', description: 'Review diffs' },
    { id: '2', trigger: 'compact', label: 'Compact context', description: 'Free space' },
    { id: '3', trigger: 'create-rule', label: 'Create rule', description: 'Workspace rules' },
    { id: '4', trigger: 'commit-message', label: 'Commit message', description: 'Git commits' }
  ]

  it('returns all items for empty or slash-only query', () => {
    expect(fuzzyMatchCommands('', items)).toHaveLength(4)
    expect(fuzzyMatchCommands('/', items)).toHaveLength(4)
  })

  it('ranks exact trigger matches first', () => {
    const hit = fuzzyMatchCommands('compact', items)
    expect(hit[0]?.trigger).toBe('compact')
  })

  it('matches ordered characters (cod → code-review)', () => {
    const hit = fuzzyMatchCommands('cod', items)
    expect(hit.some((c) => c.trigger === 'code-review')).toBe(true)
  })

  it('matches label and description', () => {
    const byLabel = fuzzyMatchCommands('context', items)
    expect(byLabel[0]?.trigger).toBe('compact')
    const byDesc = fuzzyMatchCommands('diffs', items)
    expect(byDesc[0]?.trigger).toBe('code-review')
  })
})
