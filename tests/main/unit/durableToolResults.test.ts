import { describe, expect, it } from 'vitest'
import {
  DURABLE_TOOL_RESULT_NAMES,
  isDurableToolResultName
} from '@main/agent/context/durableToolResults'

describe('durable tool results', () => {
  it('keeps verification evidence intact under trims', () => {
    expect(isDurableToolResultName('run_tests')).toBe(true)
    expect(isDurableToolResultName('diagnostics')).toBe(true)
  })

  it('keeps the pre-existing durable set', () => {
    expect(DURABLE_TOOL_RESULT_NAMES).toContain('todo_write')
    expect(DURABLE_TOOL_RESULT_NAMES).toContain('ask_question')
    expect(DURABLE_TOOL_RESULT_NAMES).toContain('memory_write')
  })

  it('leaves re-fetchable and ephemeral tools non-durable', () => {
    expect(isDurableToolResultName('read')).toBe(false)
    expect(isDurableToolResultName('edit')).toBe(false)
    expect(isDurableToolResultName(undefined)).toBe(false)
  })
})
