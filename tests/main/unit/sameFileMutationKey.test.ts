import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import type { ChatMessage } from '@shared/ipc'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/settings/settings', () => ({ getSettings: () => ({ ...DEFAULT_SETTINGS }) }))

import { executeStepToolCalls, groupStepToolCalls } from '@main/agent/executeStepTools'
import {
  beginWriteCheckpoint,
  discardWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpoint,
  resolveWrites
} from '@main/agent/checkpoints'
import { parallelMutationPathKey } from '@main/agent/tools/classify'

/**
 * Two mutations of one file spelled differently (relative vs absolute) used to
 * share a parallel batch: the second ran first, and the checkpoint captured
 * its prior after the sibling's write, so Undo kept an edit.
 */
let ws: string
let runDir: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-samefile-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-samefile-run-'))
})
afterEach(() => {
  discardWriteCheckpoint(runDir)
  rmSync(ws, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

function ctx(messages: ChatMessage[]) {
  return {
    runId: 'r',
    runDir,
    workspace: ws,
    signal: new AbortController().signal,
    appendMessage: async (m: ChatMessage) => {
      messages.push(m)
    },
    appendEvent: () => {},
    agentMode: 'agent' as const
  }
}

describe('same-file mutations under two spellings', () => {
  it('collapses lexical aliases and runs rooted spellings alone', () => {
    expect(parallelMutationPathKey({ path: 'src/./a.ts' })).toBe(parallelMutationPathKey({ path: 'src//a.ts' }))
    expect(parallelMutationPathKey({ path: 'src/x/../a.ts' })).toBe(parallelMutationPathKey({ path: 'src/a.ts' }))
    expect(parallelMutationPathKey({ path: join(ws, 'a.ts') })).toBeUndefined()
    const calls = [
      { id: 'c1', name: 'str_replace', arguments: JSON.stringify({ path: 'a.txt', old_string: 'A', new_string: 'B' }) },
      { id: 'c2', name: 'str_replace', arguments: JSON.stringify({ path: join(ws, 'a.txt'), old_string: 'B', new_string: 'C' }) }
    ]
    expect(groupStepToolCalls(calls)).toHaveLength(2)
  })

  it('applies dependent edits in call order', async () => {
    writeFileSync(join(ws, 'a.txt'), 'AAA\n', 'utf8')
    beginWriteCheckpoint(runDir, ws)
    const messages: ChatMessage[] = []
    await executeStepToolCalls(
      [
        { id: 'c1', name: 'str_replace', arguments: JSON.stringify({ path: 'a.txt', old_string: 'AAA', new_string: 'BBB' }) },
        { id: 'c2', name: 'str_replace', arguments: JSON.stringify({ path: join(ws, 'a.txt'), old_string: 'BBB', new_string: 'CCC' }) }
      ],
      ctx(messages)
    )
    expect(messages.map((m) => m.ok)).toEqual([true, true])
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('CCC\n')
  })

  it('Undo restores the original after both edits', async () => {
    writeFileSync(join(ws, 'a.txt'), 'AAA\nXXX\n', 'utf8')
    beginWriteCheckpoint(runDir, ws)
    await executeStepToolCalls(
      [
        { id: 'c1', name: 'str_replace', arguments: JSON.stringify({ path: 'a.txt', old_string: 'AAA', new_string: 'BBB' }) },
        { id: 'c2', name: 'str_replace', arguments: JSON.stringify({ path: join(ws, 'a.txt'), old_string: 'XXX', new_string: 'YYY' }) }
      ],
      ctx([])
    )
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('BBB\nYYY\n')
    const meta = finalizeWriteCheckpoint(runDir)!
    resolveWrites(runDir, ws, { checkpointId: meta.id, action: 'discard' })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('AAA\nXXX\n')
  })
})

describe('checkpoint prior with a snapshot in flight', () => {
  it('a second recordPrior waits for the first snapshot before its caller writes', async () => {
    writeFileSync(join(ws, 'b.txt'), 'original\n', 'utf8')
    beginWriteCheckpoint(runDir, ws)
    const cp = getWriteCheckpoint(runDir)!
    const first = cp.recordPrior('b.txt', 'write')
    await cp.recordPrior(join(ws, 'b.txt'), 'write')
    writeFileSync(join(ws, 'b.txt'), 'edited\n', 'utf8')
    await first
    const meta = finalizeWriteCheckpoint(runDir)!
    resolveWrites(runDir, ws, { checkpointId: meta.id, action: 'discard' })
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('original\n')
  })
})
