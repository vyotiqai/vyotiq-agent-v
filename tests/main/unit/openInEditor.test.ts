import { beforeEach, describe, expect, it, vi } from 'vitest'

const onPath = new Map<string, string>()
const spawnCalls: { bin: string; args: string[] }[] = []
const openPath = vi.fn(async () => '')

vi.mock('electron', () => ({ shell: { openPath: (...a: unknown[]) => openPath(...(a as [])) } }))
vi.mock('child_process', () => ({
  spawnSync: (_finder: string, [bin]: string[]) => {
    const hit = onPath.get(bin)
    return hit ? { status: 0, stdout: `${hit}\n` } : { status: 1, stdout: '' }
  },
  spawn: (bin: string, args: string[]) => {
    spawnCalls.push({ bin, args })
    const handlers: Record<string, () => void> = {}
    queueMicrotask(() => handlers.spawn?.())
    return {
      once: (event: string, fn: () => void) => {
        handlers[event] = fn
      },
      unref: () => {}
    }
  }
}))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return {
    ...real,
    existsSync: () => true,
    statSync: (p: string) => ({ isFile: () => !p.endsWith('/') })
  }
})

const { EDITORS, installedEditors, openInEditor, resetEditorLookupForTests, resolveEditor } = await import(
  '../../../src/main/app/openInEditor'
)

describe('open in editor', () => {
  beforeEach(() => {
    onPath.clear()
    spawnCalls.length = 0
    openPath.mockClear()
    resetEditorLookupForTests()
  })

  it('auto picks the first editor found, in order', () => {
    onPath.set('code', '/usr/bin/code')
    onPath.set('zed', '/usr/bin/zed')
    expect(resolveEditor('auto')).toEqual({ id: 'vscode', bin: '/usr/bin/code' })
    expect(installedEditors()).toEqual(['vscode', 'zed'])
  })

  it('builds each editor’s go-to-line arguments', () => {
    expect(EDITORS.vscode.args('/w/a.ts', { line: 3, column: 2 })).toEqual(['--goto', '/w/a.ts:3:2'])
    expect(EDITORS.zed.args('/w/a.ts', { line: 3 })).toEqual(['/w/a.ts:3'])
    expect(EDITORS.idea.args('/w/a.ts', { line: 3 })).toEqual(['--line', '3', '/w/a.ts'])
    expect(EDITORS.vscode.args('/w')).toEqual(['/w'])
  })

  it('opens a file at its line in the found editor', async () => {
    onPath.set('cursor', '/usr/bin/cursor')
    await expect(openInEditor('/w/a.ts', { preferred: 'auto', line: 7 })).resolves.toEqual({ editor: 'cursor' })
    expect(spawnCalls.at(-1)?.args.join(' ')).toContain('/w/a.ts:7')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('falls back to the system app under auto, and says so for a named editor', async () => {
    await expect(openInEditor('/w/a.ts', { preferred: 'auto' })).resolves.toEqual({ editor: 'system' })
    expect(openPath).toHaveBeenCalledWith('/w/a.ts')
    await expect(openInEditor('/w/a.ts', { preferred: 'zed' })).rejects.toThrow(/zed is not on PATH/)
  })
})
