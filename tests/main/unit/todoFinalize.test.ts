import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  finalizeInterruptedTodos,
  finalizeTodosOnRunEnd,
  hasInProgressTodo,
  readTodos,
  toolTodoWrite
} from '@main/agent/tools/todo'

describe('finalizeTodosOnRunEnd', () => {
  function withRunDir(fn: (runDir: string) => void): void {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-'))
    try {
      fn(runDir)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  }

  it('demotes in_progress to pending on done and error', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [
        { id: '1', content: 'Ship', status: 'in_progress' },
        { id: '2', content: 'Docs', status: 'pending' }
      ])
      expect(finalizeTodosOnRunEnd(runDir, 'done')).toMatch(/\[ \] \(1\) Ship/)
      expect(readTodos(runDir).map((t) => t.status)).toEqual(['pending', 'pending'])

      toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'in_progress' }])
      expect(finalizeTodosOnRunEnd(runDir, 'error')).toMatch(/\[ \] \(1\) Ship/)
      expect(readTodos(runDir)[0]?.status).toBe('pending')
    })
  })

  it('demotes in_progress to cancelled on interrupt', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'in_progress' }])
      expect(finalizeInterruptedTodos(runDir)).toMatch(/\[-\] \(1\) Ship/)
      expect(readTodos(runDir)[0]?.status).toBe('cancelled')
    })
  })

  it('returns null when nothing is in_progress', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'completed' }])
      expect(finalizeTodosOnRunEnd(runDir, 'done')).toBeNull()
    })
  })
})

describe('hasInProgressTodo', () => {
  function withRunDir(fn: (runDir: string) => void): void {
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-todo-progress-'))
    try {
      fn(runDir)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  }

  it('is false when todos.json is missing, empty, or all pending', () => {
    withRunDir((runDir) => {
      expect(hasInProgressTodo(runDir)).toBe(false)
      toolTodoWrite(runDir, [])
      expect(hasInProgressTodo(runDir)).toBe(false)
      toolTodoWrite(runDir, [
        { id: '1', content: 'Write the gate tests', status: 'pending' },
        { id: '2', content: 'Run the focused suite', status: 'completed' }
      ])
      expect(hasInProgressTodo(runDir)).toBe(false)
    })
  })

  it('is true when any item is in_progress', () => {
    withRunDir((runDir) => {
      toolTodoWrite(runDir, [
        { id: '1', content: 'Write the gate tests', status: 'in_progress' },
        { id: '2', content: 'Run the focused suite', status: 'pending' }
      ])
      expect(hasInProgressTodo(runDir)).toBe(true)
    })
  })
})
