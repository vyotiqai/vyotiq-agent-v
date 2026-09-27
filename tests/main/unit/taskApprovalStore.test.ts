import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TASK_APPROVALS_FILENAME,
  persistTaskAllow,
  readTaskAllowlist
} from '@main/agent/taskApprovalStore'

let runDir: string

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'vy-task-approvals-'))
})

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('task approvals', () => {
  it('reads nothing for a task that has granted nothing', () => {
    expect(readTaskAllowlist(runDir)).toEqual([])
  })

  it('reads back a grant for the next run of the same task', async () => {
    await persistTaskAllow(runDir, 'edit')
    expect(readTaskAllowlist(runDir)).toEqual(['edit'])
  })

  it('keeps both of two grants made in the same step', async () => {
    await Promise.all([persistTaskAllow(runDir, 'terminal'), persistTaskAllow(runDir, 'edit')])
    expect(readTaskAllowlist(runDir)).toEqual(['edit', 'terminal'])
  })

  it('writes a grant once however often it is given', async () => {
    await persistTaskAllow(runDir, 'edit')
    await persistTaskAllow(runDir, 'edit')
    const file = JSON.parse(readFileSync(join(runDir, TASK_APPROVALS_FILENAME), 'utf8'))
    expect(file).toEqual({ version: 1, allow: ['edit'] })
  })

  it('treats a damaged file as no grants, so the user is asked rather than let through', () => {
    writeFileSync(join(runDir, TASK_APPROVALS_FILENAME), '{ not json')
    expect(readTaskAllowlist(runDir)).toEqual([])
    writeFileSync(join(runDir, TASK_APPROVALS_FILENAME), JSON.stringify({ version: 9, allow: ['edit'] }))
    expect(readTaskAllowlist(runDir)).toEqual([])
  })
})
