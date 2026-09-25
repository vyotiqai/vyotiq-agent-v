import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-brief-${process.pid}-${Date.now()}`)

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

import { createRun } from '@main/agent/state'
import { readChecks } from '@main/agent/doneWhenChecks'

const workspace = join(tmpdir(), `vyotiq-brief-ws-${process.pid}`)

afterEach(() => {
  if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
})

describe('a new task’s done-when checks', () => {
  it('are its first checks and its contract’s Done when', () => {
    mkdirSync(workspace, { recursive: true })
    const runDir = createRun(workspace, 'run-brief-1', 'Fix the updater swap', {
      mode: 'agent',
      doneWhen: ['The updater suite passes 20 runs in a row', ' No retry or sleep around the swap ', 'the updater suite passes 20 runs in a row.']
    })
    const checks = readChecks(runDir)
    expect(checks.map((c) => [c.id, c.text, c.source, c.verdict])).toEqual([
      ['c1', 'The updater suite passes 20 runs in a row', 'brief', null],
      ['c2', 'No retry or sleep around the swap', 'brief', null]
    ])
    const contract = readFileSync(join(runDir, 'contract.md'), 'utf8')
    expect(contract).toContain('- (c1) The updater suite passes 20 runs in a row')
    expect(contract).toContain('- (c2) No retry or sleep around the swap')
    expect(contract).not.toContain('The goal above is satisfied')
  })

  it('leave the contract’s default Done when alone when the brief has none', () => {
    mkdirSync(workspace, { recursive: true })
    const runDir = createRun(workspace, 'run-brief-2', 'Tidy the settings nav', 'agent')
    expect(readChecks(runDir)).toEqual([])
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('The goal above is satisfied')
  })
})
