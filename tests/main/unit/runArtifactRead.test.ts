import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveRunDir } from '@main/storage/paths'
import { RunArtifactFixedNameSchema, RunArtifactNameSchema } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-artifact-read-${process.pid}-${Date.now()}`)

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

describe('run artifact files', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-art-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('can read all RunArtifactNameSchema files from a run dir', () => {
    const runDir = resolveRunDir(workspace, 'run-artifacts')
    mkdirSync(join(runDir, 'browser'), { recursive: true })
    writeFileSync(join(runDir, 'plan.md'), '# Plan\n', 'utf8')
    writeFileSync(join(runDir, 'contract.md'), '## Goal\n', 'utf8')
    writeFileSync(join(runDir, 'receipt.json'), '{"version":2}\n', 'utf8')
    writeFileSync(
      join(runDir, 'todos.json'),
      '{"updatedAt":"t","todos":[{"id":"1","content":"Ship","status":"pending"}]}\n',
      'utf8'
    )
    writeFileSync(join(runDir, 'browser', 'snapshot.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    writeFileSync(join(runDir, 'trajectory.jsonl'), '{"step":0,"kind":"status"}\n', 'utf8')
    writeFileSync(
      join(runDir, 'prediction.json'),
      '{"version":1,"runId":"run-artifacts","writtenAt":"t","observed_only":true,"predictions":[]}\n',
      'utf8'
    )
    writeFileSync(
      join(runDir, 'goal.json'),
      JSON.stringify({
        objective: 'Ship',
        status: 'active',
        createdAt: 't',
        updatedAt: 't'
      })
    )
    writeFileSync(
      join(runDir, 'loop.json'),
      JSON.stringify({
        prompt: 'check CI',
        intervalMs: 30_000,
        status: 'armed',
        nextAt: 't'
      })
    )

    for (const name of [
      ...RunArtifactFixedNameSchema.options,
      'browser/snapshot.jpg'
    ] as const) {
      expect(RunArtifactNameSchema.safeParse(name).success).toBe(true)
      const filePath = join(runDir, name)
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath).byteLength).toBeGreaterThan(0)
    }
    expect(RunArtifactNameSchema.safeParse('browser/snapshot-123-1.jpg').success).toBe(true)
    expect(RunArtifactNameSchema.safeParse('browser/snapshot-1700000000000-42.jpg').success).toBe(
      true
    )
  })
})
