import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import { toolDelete } from '@main/agent/tools/deletePath'
import { executeTool } from '@main/agent/tools'
import {
  beginWriteCheckpoint,
  discardWriteCheckpoint,
  finalizeWriteCheckpoint,
  resolveWrites
} from '@main/agent/checkpoints'

let root: string
let runDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-delete-link-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-delete-link-run-'))
  mkdirSync(join(root, 'packages', 'pkg', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'pkg', 'src', 'index.ts'), 'export {}\n', 'utf8')
  mkdirSync(join(root, 'node_modules', '@s'), { recursive: true })
  // Junctions need no privilege on Windows; POSIX takes a plain dir symlink.
  symlinkSync(
    join(root, 'packages', 'pkg'),
    join(root, 'node_modules', '@s', 'pkg'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
})

afterEach(() => {
  discardWriteCheckpoint(runDir)
  rmSync(root, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('delete on a link', () => {
  it('removes the link and leaves the linked directory intact', () => {
    const out = toolDelete(root, 'node_modules/@s/pkg', true)
    expect(out).toContain('Deleted link node_modules/@s/pkg')
    expect(existsSync(join(root, 'node_modules', '@s', 'pkg'))).toBe(false)
    expect(readFileSync(join(root, 'packages', 'pkg', 'src', 'index.ts'), 'utf8')).toBe('export {}\n')
  })

  it('does not record the link target as deleted in the write checkpoint', async () => {
    beginWriteCheckpoint(runDir, root)
    const result = await executeTool(
      'delete',
      JSON.stringify({ path: 'node_modules/@s/pkg', recursive: true }),
      root,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, 'packages', 'pkg', 'src', 'index.ts'))).toBe(true)
    expect(finalizeWriteCheckpoint(runDir)).toBeNull()
  })

  it('keeps Undo working for an ordinary directory delete', async () => {
    beginWriteCheckpoint(runDir, root)
    const result = await executeTool(
      'delete',
      JSON.stringify({ path: 'packages/pkg', recursive: true }),
      root,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, 'packages', 'pkg'))).toBe(false)
    const meta = finalizeWriteCheckpoint(runDir)!
    resolveWrites(runDir, root, { checkpointId: meta.id, action: 'discard' })
    expect(readFileSync(join(root, 'packages', 'pkg', 'src', 'index.ts'), 'utf8')).toBe('export {}\n')
  })
})
