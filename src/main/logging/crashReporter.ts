import { mkdirSync } from 'fs'
import { join } from 'path'
import { app, crashReporter } from 'electron'
import { pruneCrashpadReports } from './crashDiagnostics'

let started = false
let crashDumpsDir: string | undefined

function resolveCrashDumpsDir(): string {
  const dir = join(app.getPath('userData'), 'Crashpad')
  mkdirSync(join(dir, 'reports'), { recursive: true })
  mkdirSync(join(dir, 'attachments'), { recursive: true })
  pruneCrashpadReports(dir)
  try {
    app.setPath('crashDumps', dir)
  } catch {
    // setPath can fail in odd launch contexts; keep computed dir for logging.
  }
  return dir
}

/** Collect native minidumps locally; Sentry uploads when telemetry is enabled. */
export function initCrashReporter(): void {
  if (started) return
  try {
    crashDumpsDir = resolveCrashDumpsDir()
    // Prefer before app.ready. uploadToServer:false still stores Crashpad minidumps.
    // Do not set ignoreSystemCrashHandler — it can suppress useful OS/Crashpad handling.
    crashReporter.start({
      productName: 'Vyotiq',
      companyName: 'Vyotiq',
      submitURL: '',
      uploadToServer: false,
      compress: true,
      globalExtra: {
        _productName: 'Vyotiq',
        _version: crashReporterVersionTag(),
        platform: process.platform,
        arch: process.arch
      }
    })
    started = true
  } catch {
    // crashReporter must not block startup
  }
}

export function isCrashReporterStarted(): boolean {
  return started
}

export function crashDumpsDirectory(): string | undefined {
  return crashDumpsDir
}

export function crashReporterVersionTag(): string {
  try {
    return app.getVersion()
  } catch {
    return 'unknown'
  }
}
