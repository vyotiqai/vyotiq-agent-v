import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createWorkspacePathResolver, resolveInsideWorkspace } from '@main/workspace/safePath'

let base: string
let workspace: string
let outside: string

/** A directory link: a junction on Windows, which needs no symlink privilege. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

function syncResolve(relPath: string): string | null {
  try {
    return resolveInsideWorkspace(workspace, relPath)
  } catch {
    return null
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'vyotiq-resolver-'))
  workspace = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(workspace, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(outside, 'secret.txt'), 'secret\n')
  linkDir(outside, join(workspace, 'escape'))
  linkDir(join(workspace, 'src'), join(workspace, 'alias'))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('createWorkspacePathResolver', () => {
  it('agrees with resolveInsideWorkspace on where a path lands and whether it escapes', async () => {
    const resolve = createWorkspacePathResolver(workspace)
    const cases = [
      'src/a.ts',
      'src/deep',
      'src/missing.ts',
      'src/gone/one/two/three.ts',
      'alias/a.ts',
      'alias/new/file.ts',
      'escape/secret.txt',
      'escape/new.txt',
      '../outside/secret.txt'
    ]
    for (const relPath of cases) {
      const got = await resolve(relPath)
      expect(got?.real ?? null, relPath).toBe(syncResolve(relPath))
    }
  })

  it('says whether the path exists, as existsSync would', async () => {
    const resolve = createWorkspacePathResolver(workspace)
    expect((await resolve('src/a.ts'))?.exists).toBe(true)
    expect((await resolve('alias/a.ts'))?.exists).toBe(true)
    expect((await resolve('src/gone/one/two/three.ts'))?.exists).toBe(false)
  })

  it('refuses a link out of the workspace', async () => {
    const resolve = createWorkspacePathResolver(workspace)
    expect(await resolve('escape/secret.txt')).toBeNull()
    expect(await resolve('../outside/secret.txt')).toBeNull()
  })
})
