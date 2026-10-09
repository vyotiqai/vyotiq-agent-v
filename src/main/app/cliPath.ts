import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join, win32 } from 'path'
import { app } from 'electron'
import type { CliPathStatus } from '../../shared/ipc'

/**
 * The `vyotiq` command for an installed app on Windows: `resources/cli`
 * (build/cli) holds vyotiq.cmd, an sh twin for Git Bash, and path-entry.ps1,
 * which adds or removes that folder in the user PATH. The uninstaller runs
 * the same script to take it off again, so the two never disagree on what
 * counts as the entry.
 */
export function cliDir(): string | null {
  if (process.platform !== 'win32' || !app.isPackaged) return null
  const dir = join(process.resourcesPath, 'cli')
  return existsSync(join(dir, 'vyotiq.cmd')) && existsSync(join(dir, 'path-entry.ps1')) ? dir : null
}

function powershell(): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function runPathEntry(dir: string, action: 'status' | 'add' | 'remove'): Promise<boolean> {
  const script = join(dir, 'path-entry.ps1')
  return new Promise((resolve, reject) => {
    execFile(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Dir', dir],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message))
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { onPath?: unknown }
          resolve(parsed.onPath === true)
        } catch {
          reject(new Error(`Unexpected answer from path-entry.ps1: ${stdout.trim().slice(0, 200)}`))
        }
      }
    )
  })
}

export async function readCliPathStatus(): Promise<CliPathStatus> {
  const dir = cliDir()
  if (!dir) return { available: false, onPath: false, dir: null }
  return { available: true, onPath: await runPathEntry(dir, 'status'), dir }
}

export async function setCliOnPath(onPath: boolean): Promise<CliPathStatus> {
  const dir = cliDir()
  if (!dir) throw new Error('Only an installed Agent V on Windows can put vyotiq on PATH')
  return { available: true, onPath: await runPathEntry(dir, onPath ? 'add' : 'remove'), dir }
}
