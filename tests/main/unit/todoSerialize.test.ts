import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseSerializedTodoContent,
  readTodos,
  serializeTodoContent,
  toolTodoWrite
} from '@main/agent/tools/todo'

/**
 * Round-trip contract: every item written by toolTodoWrite must survive
 * serialize → parse (the path rewind sync uses via syncTodosAfterRewind),
 * including ids that would otherwise break the `[x] (id) content` line format.
 */
describe('todo id round-trip', () => {
  function withRunDir(fn: (runDir: string) => void): void {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-serialize-'))
    try {
      fn(runDir)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  }

  function expectRoundTrip(runDir: string, rawId: string, expectedId: string): void {
    const { content } = toolTodoWrite(runDir, [
      { id: rawId, content: 'Ship it', status: 'in_progress' }
    ])
    const stored = readTodos(runDir)
    expect(stored.map((t) => t.id)).toEqual([expectedId])
    // Rewind sync re-parses exactly this checklist text.
    expect(parseSerializedTodoContent(content)).toEqual(stored)
  }

  it('keeps an id containing a closing paren round-trip-safe', () => {
    withRunDir((runDir) => expectRoundTrip(runDir, 'a)b', 'ab'))
  })

  it('keeps an id with inner whitespace round-trip-safe', () => {
    withRunDir((runDir) => expectRoundTrip(runDir, 'step 1', 'step1'))
  })

  it('keeps an id with a newline round-trip-safe', () => {
    withRunDir((runDir) => expectRoundTrip(runDir, 'a\nb', 'ab'))
  })

  it('drops an id that canonicalizes to empty', () => {
    withRunDir((runDir) => {
      const { todos } = toolTodoWrite(runDir, [
        { id: ' () ', content: 'Ghost', status: 'pending' },
        { id: 'real', content: 'Real', status: 'pending' }
      ])
      expect(todos.map((t) => t.id)).toEqual(['real'])
    })
  })

  it('stays merge-stable when the raw id canonicalizes to the stored id', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [{ id: 'a)b', content: 'Ship it', status: 'pending' }])
      const { todos, content } = toolTodoWrite(
        runDir,
        [{ id: 'a)b', content: 'Ship it', status: 'in_progress' }],
        true
      )
      expect(todos).toHaveLength(1)
      expect(todos[0]).toMatchObject({ id: 'ab', status: 'in_progress' })
      expect(parseSerializedTodoContent(content)).toEqual(readTodos(runDir))
    })
  })

  it('serializes plain ids unchanged (format back-compat)', () => {
    const content = serializeTodoContent([
      { id: '1', content: 'Ship', status: 'completed' }
    ])
    expect(content).toBe('1/1 complete\n[x] (1) Ship')
    expect(parseSerializedTodoContent(content)).toEqual([
      { id: '1', content: 'Ship', status: 'completed' }
    ])
  })
})
