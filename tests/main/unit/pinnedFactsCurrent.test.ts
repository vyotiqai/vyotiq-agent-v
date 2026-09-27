import { describe, expect, it } from 'vitest'
import { extractFoldFacts, type FoldFacts } from '@main/agent/context/foldFacts'
import {
  foldFactsToPinned,
  formatPinnedFacts,
  mergeFoldFacts,
  pinnedFactsToFoldFacts
} from '@main/agent/context/pinFoldFacts'
import { requiredFoldFactsFocus, verifyCompactionSummary } from '@main/agent/context/verifyCompaction'
import type { TodoItem } from '@main/agent/tools/todo'
import type { ChatMessage } from '@shared/ipc'

const todo = (id: string, content: string, status: TodoItem['status']): TodoItem =>
  ({ id, content, status }) as TodoItem

const empty = (): FoldFacts => ({
  files: [],
  wroteFiles: [],
  decisions: [],
  todos: [],
  doneWhen: [],
  constraints: []
})

describe('pinned fold facts describe the run now', () => {
  it('drops a todo completed between folds (mirrors executeCompactEvents)', () => {
    const fold1 = foldFactsToPinned(
      extractFoldFacts([{ role: 'user', content: 'go' }], {
        todos: [todo('1', 'Write auth tests', 'pending')]
      })
    )
    expect(fold1.todos).toEqual(['Write auth tests'])

    const toSummarize: ChatMessage[] = [{ role: 'assistant', content: 'done with tests' }]
    const facts = mergeFoldFacts(
      pinnedFactsToFoldFacts(fold1),
      extractFoldFacts(toSummarize, {
        todos: [todo('1', 'Write auth tests', 'completed'), todo('2', 'Ship release notes', 'pending')]
      })
    )
    expect(facts.todos).toEqual(['Ship release notes'])
    expect(requiredFoldFactsFocus(facts)).not.toContain('Write auth tests')
    const scored = verifyCompactionSummary('## Next Steps\n- Ship release notes', facts)
    expect(scored.failures.map((f) => f.kind)).not.toContain('missing_todo')
    expect(formatPinnedFacts(foldFactsToPinned(facts))).not.toContain('Write auth tests')
  })

  it('prefers todos.json over an older todo_write snapshot in the folded prefix', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'todo_write', arguments: '{}' }] },
      {
        role: 'tool',
        toolCallId: 't1',
        toolName: 'todo_write',
        ok: true,
        content: '0/2 complete\n[ ] (1) Old open item\n[ ] (2) Still open'
      }
    ]
    const facts = extractFoldFacts(messages, {
      todos: [todo('1', 'Old open item', 'completed'), todo('2', 'Still open', 'in_progress')]
    })
    expect(facts.todos).toEqual(['Still open'])
    // No list on disk: the transcript snapshot is still the fallback.
    expect(extractFoldFacts(messages, { todos: [] }).todos).toEqual(['Old open item', 'Still open'])
  })

  it('keeps the newest entries once a cap is full', () => {
    const oldFiles = Array.from({ length: 64 }, (_, i) => `src/old/f${String(i).padStart(2, '0')}.ts`)
    const merged = mergeFoldFacts(
      { ...empty(), files: oldFiles, wroteFiles: oldFiles },
      { ...empty(), files: ['src/new/written.ts'], wroteFiles: ['src/new/written.ts'] }
    )
    expect(merged.wroteFiles).toContain('src/new/written.ts')
    expect(merged.wroteFiles).toHaveLength(64)
    expect(merged.wroteFiles).not.toContain('src/old/f00.ts')
    // Chronological order is kept: oldest survivor first, newest last.
    expect(merged.wroteFiles.at(-1)).toBe('src/new/written.ts')

    const pinned = foldFactsToPinned({
      ...empty(),
      files: [...Array.from({ length: 12 }, (_, i) => `src/a/i${i}.ts`), 'src/z/latest.ts']
    })
    expect(pinned.files).toContain('src/z/latest.ts')
    expect(pinned.files).not.toContain('src/a/i0.ts')

    const decisions = Array.from({ length: 32 }, (_, i) => `old decision ${i}`)
    expect(
      mergeFoldFacts({ ...empty(), decisions }, { ...empty(), decisions: ['brand new decision'] }).decisions
    ).toContain('brand new decision')
  })
})
