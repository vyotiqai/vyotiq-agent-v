import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The installed app's `vyotiq` command (build/cli, shipped as resources/cli).
 * path-entry.ps1 edits the user PATH for Settings and for the uninstaller;
 * here it runs on strings (-Value), never on this machine's registry.
 */

const ROOT = process.cwd()
const CLI = join(ROOT, 'build', 'cli')
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const DIR = 'C:\\Program Files\\Agent V\\resources\\cli'
const onWindows = process.platform === 'win32'

function pathEntry(action: 'status' | 'add' | 'remove', value: string): string {
  const res = spawnSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(CLI, 'path-entry.ps1'),
      '-Action',
      action,
      '-Dir',
      DIR,
      '-Value',
      value
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  )
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

/** The shim as typed at a cmd prompt: its path quoted (this one has spaces), the arguments as written. */
function runShim(args: string, app: string) {
  return spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    [`/d /s /c ""${join(CLI, 'vyotiq.cmd')}" ${args}"`],
    {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 60_000,
      env: { ...process.env, VYOTIQ_APP: app }
    }
  )
}

describe('the vyotiq command', () => {
  it('ships with Windows and comes off PATH at uninstall', () => {
    const yaml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yaml).toMatch(/^ {4}- from: build\/cli\r?\n {6}to: cli\r?$/m)
    const nsh = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
    expect(nsh).toContain('resources\\cli\\path-entry.ps1" -Action remove -Dir "$INSTDIR\\resources\\cli"')
    const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
    expect(attributes).toMatch(/^build\/cli\/\*\.cmd text eol=crlf\r?$/m)
    expect(attributes).toMatch(/^build\/cli\/vyotiq text eol=lf\r?$/m)
  })

  it.runIf(onWindows)('adds its folder once, at the end, keeping every other entry as written', () => {
    expect(pathEntry('add', 'C:\\a;%USERPROFILE%\\bin')).toBe(`C:\\a;%USERPROFILE%\\bin;${DIR}`)
    expect(pathEntry('add', 'C:\\a;')).toBe(`C:\\a;${DIR}`)
    expect(pathEntry('add', `C:\\a;"${DIR.toLowerCase()}\\";C:\\b`)).toBe(`C:\\a;"${DIR.toLowerCase()}\\";C:\\b`)
  })

  it.runIf(onWindows)('removes only its own folder, whatever its case or trailing slash', () => {
    expect(pathEntry('remove', `C:\\a;${DIR.toUpperCase()}\\;;C:\\b;${DIR}`)).toBe('C:\\a;;C:\\b')
    expect(pathEntry('remove', 'C:\\a;C:\\Program Files\\Agent V\\resources')).toBe(
      'C:\\a;C:\\Program Files\\Agent V\\resources'
    )
  })

  it.runIf(onWindows)('runs headless when the first argument is an option, and returns its exit code', () => {
    // Node stands in for Vyotiq.exe (a batch file would not: `start` runs one
    // through `cmd /K`, which re-reads the quotes). It refuses the flag the
    // shim puts first, with its own exit code.
    const res = runShim('--cwd . --prompt "hello there"', process.execPath)
    expect(res.status).toBe(9)
    expect(res.stderr).toContain('bad option: --headless')
  })

  it.runIf(onWindows)('says so when there is no app beside it', () => {
    const res = runShim('.', 'C:\\nowhere\\Vyotiq.exe')
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('vyotiq: no Agent V at')
  })
})
