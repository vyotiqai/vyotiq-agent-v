import { describe, expect, it } from 'vitest'
import {
  DelegatedTaskSchema,
  MAX_DELEGATED_TASK_PROMPT_CHARS,
  TaskEnqueueRequestSchema
} from '@shared/ipc'

const base = { profileId: 'scout', workspacePath: '/ws-a' }

describe('delegated task prompt cap', () => {
  it('accepts a brief exactly at the cap', () => {
    const result = TaskEnqueueRequestSchema.safeParse({
      ...base,
      prompt: 'x'.repeat(MAX_DELEGATED_TASK_PROMPT_CHARS)
    })
    expect(result.success).toBe(true)
  })

  it('rejects one character past the cap and names the field', () => {
    const result = TaskEnqueueRequestSchema.safeParse({
      ...base,
      prompt: 'x'.repeat(MAX_DELEGATED_TASK_PROMPT_CHARS + 1)
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['prompt'])
  })

  it('stores what it accepts — the persisted record shares the same cap', () => {
    const result = DelegatedTaskSchema.safeParse({
      id: 'task-1',
      ...base,
      prompt: 'x'.repeat(MAX_DELEGATED_TASK_PROMPT_CHARS),
      status: 'queued',
      createdAt: '2026-09-19T00:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })
})
