import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'fs'
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

  it('rereads a command whose body changed but whose directory did not', async () => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-slash-fp-'))
    const dir = join(root, '.vyotiq', 'commands')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'ship.md')
    writeFileSync(file, '---\nname: ship\n---\nShip v1')

    const before = await readWorkspaceCommands(root)
    expect(before.find((f) => f.trigger === 'ship')?.body).toBe('Ship v1')

    const dirMtimeBefore = statSync(dir).mtimeMs
    writeFileSync(file, '---\nname: ship\n---\nShip v2')
    // Move the file's mtime forward so the check cannot hinge on clock resolution.
    utimesSync(file, new Date(), new Date(Date.now() + 2000))
    // An in-place write leaves the parent directory's mtime alone, which is why a
    // directory-only fingerprint served the stale body for the whole TTL. If this
    // ever fails, the test below stops proving anything — it is not incidental.
    expect(statSync(dir).mtimeMs).toBe(dirMtimeBefore)

    const after = await readWorkspaceCommands(root)
    expect(after.find((f) => f.trigger === 'ship')?.body).toBe('Ship v2')
  })
})
