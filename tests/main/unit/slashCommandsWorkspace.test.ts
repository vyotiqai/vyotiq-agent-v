import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWorkspaceCommandsCache,
  listWorkspaceCommands,
  readWorkspaceCommands,
  resolveWorkspaceCommand
} from '../../../src/main/agent/slashCommands/workspaceCommands'

let root: string | null = null

afterEach(() => {
  clearWorkspaceCommandsCache()
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('workspace slash commands', () => {
  it('loads .vyotiq/commands and .cursor/commands with vyotiq winning collisions', async () => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-slash-'))
    mkdirSync(join(root, '.vyotiq', 'commands'), { recursive: true })
    mkdirSync(join(root, '.cursor', 'commands'), { recursive: true })
    writeFileSync(
      join(root, '.vyotiq', 'commands', 'ship.md'),
      '---\nname: ship\ndescription: Vyotiq ship\n---\nShip it {{input}}\n'
    )
    writeFileSync(
      join(root, '.cursor', 'commands', 'ship.md'),
      '---\nname: ship\ndescription: Cursor ship\n---\nCursor ship\n'
    )
    writeFileSync(join(root, '.cursor', 'commands', 'run-tests.md'), 'Run the test suite')

    const files = await readWorkspaceCommands(root)
    expect(files.find((f) => f.trigger === 'ship')?.source).toBe('vyotiq')
    expect(files.find((f) => f.trigger === 'run-tests')?.body).toContain('Run the test suite')

    const listed = await listWorkspaceCommands(root)
    expect(listed.some((c) => c.trigger === 'ship' && c.group === 'Commands')).toBe(true)

    const ship = listed.find((c) => c.trigger === 'ship')!
    const resolved = await resolveWorkspaceCommand(ship.id, root, 'v1')
    expect(resolved).toEqual({
      action: 'send',
      message: 'Ship it v1'
    })
  })
})
