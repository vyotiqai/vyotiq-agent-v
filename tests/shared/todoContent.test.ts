import { describe, expect, it } from 'vitest'
import {
  finalizeInterruptedTodoContent,
  finalizeTodoContentOnRunEnd,
  todoContentHasInProgress
} from '@shared/utils/todoContent'

describe('todoContent', () => {
  it('detects in-progress checklist markers', () => {
    expect(todoContentHasInProgress('0/2 complete\n[ ] One\n[~] Two')).toBe(true)
    expect(todoContentHasInProgress('0/2 complete\n[ ] One\n[-] Two')).toBe(false)
  })

  it('demotes in-progress tasks to cancelled on interrupt', () => {
    expect(
      finalizeInterruptedTodoContent(
        '0/5 complete\n[~] Audit core library files\n[ ] Audit API routes'
      )
    ).toBe('0/5 complete\n[-] Audit core library files\n[ ] Audit API routes')
  })

  it('demotes in-progress tasks to pending on done and error', () => {
    const content = '1/2 complete\n[x] Done\n[~] Ship'
    expect(finalizeTodoContentOnRunEnd(content, 'done')).toBe('1/2 complete\n[x] Done\n[ ] Ship')
    expect(finalizeTodoContentOnRunEnd(content, 'error')).toBe('1/2 complete\n[x] Done\n[ ] Ship')
  })
})
