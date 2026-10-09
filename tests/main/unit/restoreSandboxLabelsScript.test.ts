import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The uninstaller's label restore (build/uninstall/restore-sandbox-labels.ps1,
 * run from build/installer.nsh). It runs once, on someone else's machine, at
 * uninstall, so it is checked here for real: a folder labelled low by icacls,
 * the record the app writes, then the script.
 */

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'build', 'uninstall', 'restore-sandbox-labels.ps1')
const ICACLS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function labelOf(path: string): string {
  return spawnSync(ICACLS, [path], { encoding: 'utf8', windowsHide: true }).stdout
}

function runScript(record: string): number | null {
  return spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Record', record],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  ).status
}

describe('the uninstaller hook', () => {
  it('is wired: nsis includes it and Windows ships the script', () => {
    const yaml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yaml).toMatch(/^ {2}include: build\/installer\.nsh\r?$/m)
    expect(yaml).toMatch(/^ {4}- from: build\/uninstall\r?\n {6}to: uninstall\r?$/m)
    const nsh = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
    expect(nsh).toContain('!macro customUnInstall')
    expect(nsh).toContain('${ifNot} ${isUpdated}')
    expect(nsh).toContain('resources\\uninstall\\restore-sandbox-labels.ps1')
    expect(nsh).toContain('sandbox\\labels.json')
  })

  it('adds "Open in Agent V" to folders in Explorer, and takes it off at uninstall', () => {
    const nsh = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
    const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macroend'))
    for (const key of ['Directory\\shell\\AgentV', 'Directory\\Background\\shell\\AgentV']) {
      expect(install).toContain(`"Software\\Classes\\${key}\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%V"'`)
      expect(nsh).toContain(`DeleteRegKey SHCTX "Software\\Classes\\${key}"`)
    }
  })
})

describe.skipIf(process.platform !== 'win32')('restore-sandbox-labels.ps1 on this machine', () => {
  it('puts a low folder back to medium and leaves the rest alone', () => {
    const base = mkdtempSync(join(tmpdir(), 'vyotiq-uninstall-labels-'))
    made.push(base)
    const ws = join(base, 'ws')
    const already = join(base, 'medium')
    spawnSync('cmd.exe', ['/d', '/c', 'mkdir', ws, already], { windowsHide: true })
    expect(spawnSync(ICACLS, [ws, '/setintegritylevel', '(OI)(CI)low', '/Q'], { windowsHide: true }).status).toBe(0)
    expect(labelOf(ws)).toMatch(/Low Mandatory Level/)

    const record = join(base, 'labels.json')
    writeFileSync(
      record,
      JSON.stringify({
        [ws.toLowerCase()]: { path: ws, level: 'low', birthtimeMs: 1 },
        [already.toLowerCase()]: { path: already, level: 'medium', birthtimeMs: 1 },
        gone: { path: join(base, 'not-there'), level: 'low', birthtimeMs: 1 }
      }),
      'utf8'
    )
    expect(runScript(record)).toBe(0)
    expect(labelOf(ws)).not.toMatch(/Low Mandatory Level/)
    expect(labelOf(already)).not.toMatch(/Mandatory Level/)
  }, 90_000)

  it('exits cleanly with no record, or one it cannot read', () => {
    const base = mkdtempSync(join(tmpdir(), 'vyotiq-uninstall-labels-'))
    made.push(base)
    expect(runScript(join(base, 'missing.json'))).toBe(0)
    const bad = join(base, 'labels.json')
    writeFileSync(bad, '{ not json', 'utf8')
    expect(runScript(bad)).toBe(0)
  }, 90_000)
})
