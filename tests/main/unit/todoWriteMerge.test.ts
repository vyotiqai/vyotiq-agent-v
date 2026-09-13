import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readTodos, toolTodoWrite } from '@main/agent/tools/todo'
import { validateToolArgs } from '@main/agent/schemas/tools'

/**
 * Regression: a live todo_write call with merge:true and status-only entries
 * failed with 'todos.0.content: Required; todos.1.content: Required;
 * todos.2.content: Required' (the running app predated the merge exemption).
 * These are the exact logged failing args.
 */
const loggedArgs = {
  merge: true,
  todos: [
    { id: '1', status: 'completed' },
    { id: '2', status: 'completed' },
    { id: '3', status: 'in_progress' }
  ]
}

describe('todo_write merge validation', () => {
  it('accepts merge:true with status-only entries (logged failure args)', () => {
    const result = validateToolArgs('todo_write', JSON.stringify(loggedArgs))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.merge).toBe(true)
      expect(result.data.todos).toHaveLength(3)
    }
  })

  it('still requires content when merge is not true', () => {
    const result = validateToolArgs('todo_write', JSON.stringify({ todos: loggedArgs.todos }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('todos.0.content')
  })
})

describe('toolTodoWrite merge execution', () => {
  function withRunDir(fn: (runDir: string) => void): void {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-merge-'))
    try {
      fn(runDir)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  }

  it('backfills content from the stored list for status-only entries', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [
        { id: '1', content: 'First stored task', status: 'pending' },
        { id: '2', content: 'Second stored task', status: 'pending' },
        { id: '3', content: 'Third stored task', status: 'pending' }
      ])

      const result = toolTodoWrite(
        runDir,
        [
          { id: '1', status: 'completed' },
          { id: '2', status: 'completed' },
          { id: '3', status: 'in_progress' }
        ],
        true
      )

      const stored = readTodos(runDir)
      expect(stored.map((t) => `${t.status}:${t.content}`)).toEqual([
        'completed:First stored task',
        'completed:Second stored task',
        'in_progress:Third stored task'
      ])
      expect(result.todos.map((t) => t.status)).toEqual([
        'completed',
        'completed',
        'in_progress'
      ])
      expect(result.content).toMatch(/\[x\] \(1\) First stored task/)
    })
  })

  it('demotes extra in_progress items on merge, keeping one', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [
        { id: '1', content: 'First stored task', status: 'pending' },
        { id: '2', content: 'Second stored task', status: 'pending' }
      ])

      const result = toolTodoWrite(
        runDir,
        [
          { id: '1', status: 'in_progress' },
          { id: '2', status: 'in_progress' }
        ],
        true
      )

      expect(result.notice).toContain('demoted 1 to pending (kept 2)')
      expect(readTodos(runDir).map((t) => t.status)).toEqual(['pending', 'in_progress'])
    })
  })

  it('drops a status-only entry with no stored match', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [{ id: '1', content: 'Only stored task', status: 'pending' }])

      toolTodoWrite(runDir, [{ id: '1', status: 'completed' }, { id: '404', status: 'pending' }], true)

      const stored = readTodos(runDir)
      expect(stored.map((t) => `${t.id}:${t.status}:${t.content}`)).toEqual([
        '1:completed:Only stored task'
      ])
    })
  })
})

describe('create_plan todos validation', () => {
  it('accepts status-only todos entries (create_plan always merges by id)', () => {
    const result = validateToolArgs(
      'create_plan',
      JSON.stringify({
        title: 'Regression plan',
        plan: '# Regression plan\n\n## Goal\n\nCover the merge path.',
        todos: [{ id: '1', status: 'completed' }]
      })
    )
    expect(result.ok).toBe(true)
  })
})
