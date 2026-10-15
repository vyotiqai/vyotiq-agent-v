import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import { messagesToUiItems } from '@shared/transcript'
import { buildRecordModel } from '@renderer/features/task/recordModel'

// The record loads a window of the transcript; main counts the runs above it
// (`runsBefore`) so the numbers count from the task's first run, not the window's.
const numbers = (messages: ChatMessage[], runsBefore?: number): number[] =>
  buildRecordModel(messagesToUiItems(messages), { running: false, runsBefore }).runs.map((r) => r.n)

describe('record run numbers', () => {
  it('count from the window when nothing is above it', () => {
    expect(
      numbers([
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'b' }
      ])
    ).toEqual([1, 2])
  })

  it('carry on from the runs above a window that opens on an instruction', () => {
    expect(
      numbers(
        [
          { role: 'user', content: 'six' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'seven' }
        ],
        5
      )
    ).toEqual([6, 7])
  })

  it('give a window that opens partway through a run the number of the run it continues', () => {
    expect(
      numbers(
        [
          { role: 'assistant', content: 'still working' },
          { role: 'user', content: 'six' },
          { role: 'assistant', content: 'b' }
        ],
        5
      )
    ).toEqual([5, 6])
  })
})
