import { describe, expect, it, vi } from 'vitest'
import { workspacePathFromArgv } from '@main/app/deepLinks'

vi.mock('electron', () => ({ app: { on: vi.fn(), setAsDefaultProtocolClient: vi.fn() } }))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

/** A fake disk: these folders exist. */
const dirs = new Set(['/work/repo', '/work/repo/sub', '/home/dev/other'])
const isDirectory = (p: string): boolean => dirs.has(p.replace(/\\/g, '/').replace(/^[A-Z]:/i, ''))

describe('workspacePathFromArgv', () => {
  it('takes a folder named on the command line', () => {
    expect(workspacePathFromArgv(['Vyotiq.exe', '/home/dev/other'], { start: 1, cwd: '/work/repo', isDirectory })).toMatch(
      /home[\\/]dev[\\/]other$/
    )
  })

  it('resolves `.` and relative paths against the launching folder', () => {
    expect(workspacePathFromArgv(['Vyotiq.exe', '.'], { start: 1, cwd: '/work/repo', isDirectory })).toMatch(/work[\\/]repo$/)
    expect(workspacePathFromArgv(['Vyotiq.exe', 'sub'], { start: 1, cwd: '/work/repo', isDirectory })).toMatch(/repo[\\/]sub$/)
  })

  it('skips switches, links, files, the app path in a dev run, and missing folders', () => {
    const opts = { start: 2, cwd: '/work/repo', isDirectory }
    expect(workspacePathFromArgv(['electron.exe', '.', '--allow-file-access-from-files'], opts)).toBeNull()
    expect(workspacePathFromArgv(['electron.exe', '.', 'vyotiq://run/abc'], opts)).toBeNull()
    expect(workspacePathFromArgv(['electron.exe', '.', 'README.md'], opts)).toBeNull()
    expect(workspacePathFromArgv(['electron.exe', '.', '/nope'], opts)).toBeNull()
  })
})
