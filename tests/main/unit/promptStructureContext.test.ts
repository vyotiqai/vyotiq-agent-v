import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  memoryRoot: vi.fn(),
  listRuns: vi.fn(),
  loadMessagesWindowAsync: vi.fn()
}))

vi.mock('@main/agent/context/memory', () => ({ memoryRoot: mocks.memoryRoot }))
vi.mock('@main/agent/state', () => ({
  listRuns: mocks.listRuns,
  loadMessagesWindowAsync: mocks.loadMessagesWindowAsync
}))

import { gatherStructureContext } from '@main/agent/promptStructure/context'

let ws = ''
let mem = ''

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-structure-ws-'))
  mem = mkdtempSync(join(tmpdir(), 'vyotiq-structure-mem-'))
  mkdirSync(join(ws, 'src', 'composer'), { recursive: true })
  writeFileSync(join(ws, 'src', 'composer', 'Composer.tsx'), 'export {}')
  writeFileSync(join(ws, 'src', 'composer', 'paste.ts'), 'export {}')
  writeFileSync(join(ws, 'pnpm-lock.yaml'), '')
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }))
  writeFileSync(join(ws, 'CLAUDE.md'), '# Rules\n\n## Composer\nComposer buttons are xs.\n')
  mkdirSync(join(mem, 'notes'), { recursive: true })
  writeFileSync(join(mem, 'index.md'), '# Memory\n- [Composer paste](notes/paste.md) — paste crash came from the clipboard reader\n- [Billing](notes/billing.md) — invoices\n')
  writeFileSync(join(mem, 'notes', 'paste.md'), 'The composer paste crash came from reading a file list twice.')
  mocks.memoryRoot.mockReturnValue(mem)
  mocks.listRuns.mockResolvedValue({
    runs: [{ runId: 'old', goal: 'Fix composer paste of images', status: 'done', updatedAt: '2026-10-01T00:00:00Z' }],
    instanceRuns: [],
    capped: false
  })
  mocks.loadMessagesWindowAsync.mockRejectedValue(new Error('no transcript'))
})

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(mem, { recursive: true, force: true })
})

describe('gatherStructureContext', () => {
  it('brings the sources together, each cut to the request, and survives one that fails', async () => {
    const ctx = await gatherStructureContext({
      workspacePath: ws,
      text: 'fix the composer paste crash',
      mentions: [],
      runId: 'current'
    })
    expect(ctx.rules).toContain('Composer buttons are xs.')
    // By name, never by path: memory notes are not workspace files.
    expect(ctx.memory).toContain('- Composer paste — paste crash came from the clipboard reader')
    expect(ctx.memory).not.toContain('notes/')
    expect(ctx.memory).toContain('Memory note "paste"')
    expect(ctx.memory).toContain('reading a file list twice')
    expect(ctx.memory).not.toContain('Billing')
    expect(ctx.pastTasks).toBe('- Fix composer paste of images — finished, 2026-10-01')
    // The transcript could not be read: the brief goes without it.
    expect(ctx.thread).toBe('')
    expect(ctx.relevantPaths).toContain('src/composer/paste.ts')
    expect(ctx.scripts).toContain('`pnpm test` → vitest run')
    expect(ctx.known.packageManager).toBe('pnpm')
    expect([...ctx.known.scripts]).toEqual(['test', 'lint'])
    expect(ctx.known.files).toContain('src/composer/Composer.tsx')
  })
})
