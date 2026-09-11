import { describe, expect, it } from 'vitest'
import {
  formatAgentInstanceLabel,
  formatAgentInstanceShortId,
  parseAgentInstanceRunId,
  parseAgentInstanceRunIdFromArgs
} from '@shared/utils/agentInstance'

describe('agentInstance utils', () => {
  it('formats inline instance label', () => {
    expect(formatAgentInstanceLabel('abc123')).toBe('Agent V Instance id; abc123 (short abc123)')
  })

  it('formats short instance id from uuid prefix', () => {
    expect(formatAgentInstanceShortId('584c0a1c-434a-4ddf-85c5-a05bb80fd696')).toBe('584c0a1c')
  })

  it('parses run id from spawn tool content', () => {
    expect(
      parseAgentInstanceRunId('Agent V Instance id; child-1\nrun_id: child-1')
    ).toBe('child-1')
    expect(parseAgentInstanceRunId('run_id: xyz')).toBe('xyz')
  })

  it('parses run id from await args preview', () => {
    expect(
      parseAgentInstanceRunIdFromArgs(JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696' }))
    ).toBe('584c0a1c-434a-4ddf-85c5-a05bb80fd696')
  })
})
