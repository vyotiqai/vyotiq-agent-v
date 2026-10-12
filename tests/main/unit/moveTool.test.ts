import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import { beginWriteCheckpoint, discardWriteCheckpoint, resolveWrites } from '@main/agent/checkpoints'
import { movedFileDestinations, toolMove } from '@main/agent/tools/movePath'
import { applyToolCallToMutationPaths } from '@main/agent/loopPolicy'

let workspace: string
let runDir: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-move-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-move-run-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('move tool', () => {
  it('renames a file, creating the folders it needs', () => {
    writeFileSync(join(workspace, 'a.ts'), 'a', 'utf8')
    expect(toolMove(workspace, 'a.ts', 'lib/b.ts')).toBe('Moved a.ts → lib/b.ts')
    expect(existsSync(join(workspace, 'a.ts'))).toBe(false)
    expect(readFileSync(join(workspace, 'lib', 'b.ts'), 'utf8')).toBe('a')
  })

  it('moves a folder, and refuses to move it into itself', () => {
    mkdirSync(join(workspace, 'src', 'util'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'util', 'x.ts'), 'x', 'utf8')
    expect(() => toolMove(workspace, 'src', 'src/inner')).toThrow(/into itself/)
    expect(toolMove(workspace, 'src', 'pkg')).toBe('Moved folder src → pkg')
    expect(readFileSync(join(workspace, 'pkg', 'util', 'x.ts'), 'utf8')).toBe('x')
  })

  it('never replaces a file unless told to, and never the root', () => {
    writeFileSync(join(workspace, 'a.ts'), 'a', 'utf8')
    writeFileSync(join(workspace, 'b.ts'), 'b', 'utf8')
    expect(() => toolMove(workspace, 'a.ts', 'b.ts')).toThrow(/already exists/)
    expect(toolMove(workspace, 'a.ts', 'b.ts', true)).toBe('Moved a.ts → b.ts')
    expect(readFileSync(join(workspace, 'b.ts'), 'utf8')).toBe('a')
    expect(() => toolMove(workspace, '.', 'elsewhere')).toThrow(/workspace root/)
    expect(() => toolMove(workspace, 'b.ts', '../outside.ts')).toThrow()
  })

  it('is undoable: the checkpoint restores the source and removes the destination', async () => {
    mkdirSync(join(workspace, 'old'), { recursive: true })
    writeFileSync(join(workspace, 'old', 'one.ts'), '1', 'utf8')
    writeFileSync(join(workspace, 'old', 'two.ts'), '2', 'utf8')
    const cp = beginWriteCheckpoint(runDir, workspace)
    const dests = movedFileDestinations(workspace, 'old', 'new')
    expect(dests.sort()).toEqual(['new/one.ts', 'new/two.ts'])
    for (const dest of dests) await cp.recordPrior(dest, 'write')
    await cp.recordPrior('old', 'delete', { recursiveDir: true })
    toolMove(workspace, 'old', 'new')
    const meta = cp.finalize()
    discardWriteCheckpoint(runDir)
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    expect(readFileSync(join(workspace, 'old', 'one.ts'), 'utf8')).toBe('1')
    expect(existsSync(join(workspace, 'new', 'one.ts'))).toBe(false)
  })

  it('stages both ends for a scoped commit', () => {
    const mutations = new Set<string>()
    applyToolCallToMutationPaths(mutations, 'move', { from: 'src/a.ts', to: 'lib/a.ts' }, true)
    expect([...mutations].sort()).toEqual(['lib/a.ts', 'src/a.ts'])
  })
})
