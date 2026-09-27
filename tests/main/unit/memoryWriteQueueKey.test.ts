/**
 * The mutation queue must be keyed by the file that is actually written.
 *
 * `memory_write` built its key from the raw model-supplied path and only
 * validated inside `toolMemoryWrite`, so a path the normaliser rejects still
 * reserved a queue slot — and after normalisation the slot can name a path
 * that no write ever touches. Both mean two different notes can mutate the
 * same file's queue slot, or a rejected call can block a real one.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queueState = vi.hoisted(() => ({ keys: [] as string[] }))

vi.mock('@main/workspace/mutationQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/workspace/mutationQueue')>()
  return {
    ...actual,
    withWorkspaceMutation: (workspacePath: string, relPath: string, operation: () => unknown) => {
      queueState.keys.push(relPath)
      return actual.withWorkspaceMutation(workspacePath, relPath, operation as () => void)
    }
  }
})

import { executeTool } from '@main/agent/tools'
import { normalizeMemoryRelPath } from '@main/agent/tools/memory'

let dir: string

function write(path: string, contents = 'x') {
  return executeTool(
    'memory_write',
    JSON.stringify({ path, contents }),
    dir,
    new AbortController().signal
  )
}

beforeEach(() => {
  queueState.keys = []
  dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-key-'))
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('memory_write mutation queue key', () => {
  it('keys the queue on the normalised path, not the raw model arg', async () => {
    // Every form below writes notes/arch.md; all must reserve that one slot.
    for (const raw of ['notes/arch.md', '  notes/arch.md  ', '/notes/arch.md']) {
      queueState.keys = []
      const result = await write(raw, 'note')
      expect(result.ok, raw).toBe(true)
      expect(result.content, raw).toBe('Wrote memory/notes/arch.md')
      expect(queueState.keys, raw).toEqual([`.vyotiq/memory/${normalizeMemoryRelPath(raw)}`])
    }
  })

  it('reserves no queue slot for a path the normaliser rejects', async () => {
    // Each of these keys the REAL notes/arch.md slot today (pathKey strips the
    // backslashes / trailing slash), so a rejected call collides with a
    // legitimate concurrent write to that note.
    for (const raw of ['notes\\arch.md', 'notes/arch.md/', '../notes/arch.md', 'other.md']) {
      queueState.keys = []
      const result = await write(raw, 'nope')
      expect(result.ok, raw).toBe(false)
      expect(queueState.keys, raw).toEqual([])
    }
  })

  it('keeps the model-facing rejection messages', async () => {
    // Validation moved ahead of the queue, not into it: the errors must read
    // exactly as they did.
    const traversal = await write('../secrets.txt', 'nope')
    expect(traversal.ok).toBe(false)
    expect(traversal.content).toMatch(/Invalid memory path/)

    const foreign = await write('other.md', 'nope')
    expect(foreign.ok).toBe(false)
    expect(foreign.content).toMatch(/path must be index\.md, state\.md/)

    const unsafeNote = await write('notes/a b.md', 'nope')
    expect(unsafeNote.ok).toBe(false)
    expect(unsafeNote.content).toMatch(/safe characters/)
  })
})
