import { app, BrowserWindow, dialog, shell } from 'electron'
import { readdir, readFile, writeFile } from 'fs/promises'
import { arch, cpus, homedir, release, totalmem, type as osType, userInfo } from 'os'
import { basename, join } from 'path'
import type { DiagnosticsExportResult } from '../../shared/ipc'
import { getCrashDiagnosticsSnapshot } from '../logging/crashDiagnostics'
import { logsDirectory } from '../logging/init'
import { collectLoadSnapshot, collectProcessMetrics } from '../perf/loadSnapshot'
import { getSettings } from '../settings/settings'
import { buildDiagnosticsZip, diagnosticsFileName, type RedactionContext } from './bundle'

function section<T>(read: () => T): T | { unavailable: string } {
  try {
    return read()
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) }
  }
}

function redactionContext(): RedactionContext {
  let username = ''
  try {
    username = userInfo().username
  } catch {
    // No passwd entry (some containers): the home folder still goes.
  }
  return { home: homedir(), username }
}

/** The app log and its rotated archive (electron-log keeps one, `vyotiq.old.log`), current first. */
async function readLogs(): Promise<Array<{ name: string; text: string }>> {
  const dir = logsDirectory()
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.log'))
  } catch {
    return []
  }
  names.sort((a, b) => Number(a.includes('.old')) - Number(b.includes('.old')) || a.localeCompare(b))
  const logs: Array<{ name: string; text: string }> = []
  for (const name of names) {
    try {
      logs.push({ name, text: await readFile(join(dir, name), 'utf8') })
    } catch {
      // Rotated away between the listing and the read.
    }
  }
  return logs
}

/** Ask where, write the redacted bundle there, and show it in the file manager. */
export async function exportDiagnostics(parent: BrowserWindow | null): Promise<DiagnosticsExportResult> {
  const now = new Date()
  const options: Electron.SaveDialogOptions = {
    title: 'Export diagnostics',
    defaultPath: join(app.getPath('downloads'), diagnosticsFileName(now)),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }]
  }
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { saved: false }

  const { zip, files } = buildDiagnosticsZip({
    now,
    system: {
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      os: `${osType()} ${release()}`,
      platform: process.platform,
      arch: arch(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      locale: app.getLocale(),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? null,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime())
    },
    settings: section(() => getSettings()),
    crashes: section(() => getCrashDiagnosticsSnapshot()),
    perf: {
      processes: section(() => collectProcessMetrics()),
      load: section(() => collectLoadSnapshot())
    },
    logs: await readLogs(),
    ctx: redactionContext()
  })
  await writeFile(picked.filePath, zip)
  shell.showItemInFolder(picked.filePath)
  return { saved: true, fileName: basename(picked.filePath), bytes: zip.length, files }
}
