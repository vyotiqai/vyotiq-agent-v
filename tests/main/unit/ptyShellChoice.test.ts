import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ terminalShell: 'cmd', terminalShellPath: '' })
}))

const { resolvePtyShell, shellProgramTitle, renamePty } = await import('@main/app/ptySessions')

/** Which program a terminal tab runs: Settings, the Shell program path, or the menu's pick. */
describe('resolvePtyShell', () => {
  it('follows the Shell setting by default', () => {
    expect(resolvePtyShell('default', { platform: 'win32' })).toEqual({ file: 'cmd.exe', args: [], title: 'cmd' })
  })

  it('runs the Shell program path for a default tab, named after the program', () => {
    expect(resolvePtyShell('default', { customPath: '"C:\\Tools\\nu.exe"' })).toEqual({ file: 'C:\\Tools\\nu.exe', args: [], title: 'nu' })
    expect(resolvePtyShell(undefined, { customPath: '/usr/bin/fish' }).title).toBe('fish')
  })

  it('lets a tab picked from the menu name its shell, over the path', () => {
    expect(resolvePtyShell('bash', { customPath: '/usr/bin/fish' })).toEqual({ file: 'bash', args: ['-l'], title: 'bash' })
    expect(resolvePtyShell('wsl', { customPath: 'zsh' })).toEqual({ file: 'wsl.exe', args: [], title: 'WSL' })
    expect(resolvePtyShell('powershell', { platform: 'linux' })).toEqual({ file: 'pwsh', args: ['-NoLogo'], title: 'PowerShell' })
  })

  it('names a program from its path', () => {
    expect(shellProgramTitle('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(shellProgramTitle('  ')).toBe('shell')
  })

  it('refuses to rename a session that is not there', () => {
    expect(renamePty('missing', 'x')).toBe(false)
  })
})
