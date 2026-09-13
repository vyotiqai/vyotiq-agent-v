import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'

const userData = join(tmpdir(), `vyotiq-read-plan-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import { readPlanAsync, readPlanRawAsync } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

describe('readPlanAsync', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-read-plan-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('returns empty for the seeded stub', async () => {
    const runDir = resolveRunDir(workspace, 'stub')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'plan.md'), DEFAULT_PLAN_STUB, 'utf8')
    expect(await readPlanAsync(runDir)).toBe('')
  })

  it('returns a filled plan', async () => {
    const runDir = resolveRunDir(workspace, 'filled')
    mkdirSync(runDir, { recursive: true })
    const body = [
      '# Plan',
      '',
      '## Goal',
      '',
      'Ship the structured planner.',
      ''
    ].join('\n')
    writeFileSync(join(runDir, 'plan.md'), body, 'utf8')
    expect(await readPlanAsync(runDir)).toContain('Ship the structured planner.')
  })

  it('returns long plans in full (no truncation)', async () => {
    const runDir = resolveRunDir(workspace, 'long')
    mkdirSync(runDir, { recursive: true })
    const steps = Array.from(
      { length: 200 },
      (_, i) => `${i + 1}. Step ${i + 1} — edit src/module/file${i}.ts and verify`
    ).join('\n')
    const text = ['# Plan', '', '## Goal', '', 'Ship the structured planner.', '', '## Ordered steps', '', steps, ''].join('\n')
    writeFileSync(join(runDir, 'plan.md'), text, 'utf8')
    expect(text.length).toBeGreaterThan(4000)
    const plan = await readPlanAsync(runDir)
    expect(plan).toBe(text.trim())
    expect(plan).not.toContain('…')
  })

  it('treats plans whose content lives in custom headings as real', async () => {
    const runDir = resolveRunDir(workspace, 'headings')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'plan.md'),
      ['# Plan', '', '## 1. Add the endpoint', '', '## 2. Wire the handler', ''].join('\n'),
      'utf8'
    )
    expect(await readPlanAsync(runDir)).toContain('## 1. Add the endpoint')
  })
})

describe('readPlanRawAsync', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-read-plan-raw-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('returns the stub verbatim so Plan mode can mirror it', async () => {
    const runDir = resolveRunDir(workspace, 'raw-stub')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'plan.md'), DEFAULT_PLAN_STUB, 'utf8')
    expect(await readPlanRawAsync(runDir)).toBe(DEFAULT_PLAN_STUB.trim())
  })

  it('returns empty when plan.md is missing', async () => {
    const runDir = resolveRunDir(workspace, 'raw-missing')
    mkdirSync(runDir, { recursive: true })
    expect(await readPlanRawAsync(runDir)).toBe('')
  })
})
