/**
 * The disk side of the Windows sandbox (windows.ts holds the pure rules):
 * the low-labelled shell copies, the folder labels, and the scripts a shell
 * that cannot take a long command line runs from.
 *
 * Labels are remembered in `<userData>/sandbox/labels.json` with each path's
 * creation time, so a folder is labelled once — a 200,000-file workspace takes
 * about half a minute — and labelled again only when it was made anew (a task
 * worktree recreated at the same path starts unlabelled). The record also
 * says what to put back when the sandbox is turned off.
 */
import { execFile, spawnSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { win32 } from 'path'
import { logger } from '../../../shared/logger'
import {
  icaclsLabelArgs,
  LOW_INTEGRITY_SID,
  lowIntegrityShellPaths,
  lowIntegrityTempDir,
  sandboxScriptName,
  type IntegrityLabel,
  type LowIntegrityShells
} from './windows'

const ICACLS_TIMEOUT_MS = 10 * 60_000
const SCRIPT_MAX_AGE_MS = 24 * 60 * 60_000

function systemRoot(): string {
  return process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
}

function icaclsPath(): string {
  return win32.join(systemRoot(), 'System32', 'icacls.exe')
}

function sameSize(a: string, b: string): boolean {
  try {
    return statSync(a).size === statSync(b).size
  } catch {
    return false
  }
}

/** Copy `source` to `target` (when it is missing or differs) and label the copy low. */
function lowCopy(source: string, target: string): { ok: true } | { ok: false; detail: string } {
  if (!existsSync(source)) return { ok: false, detail: `${source} is missing` }
  try {
    if (!existsSync(target) || !sameSize(source, target)) copyFileSync(source, target)
  } catch (err) {
    return { ok: false, detail: `could not copy ${win32.basename(source)}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const res = spawnSync(icaclsPath(), [target, '/setintegritylevel', 'low', '/Q'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true
  })
  if (res.error || res.status !== 0) {
    return { ok: false, detail: `icacls could not label ${win32.basename(target)}: ${(res.stderr || res.error?.message || '').trim()}` }
  }
  return { ok: true }
}

/**
 * Make the low-labelled cmd and Windows PowerShell copies and prove a command
 * started from one really runs at low integrity. PowerShell is optional:
 * without it, PowerShell commands go through the cmd copy.
 */
export function prepareLowIntegrityShells(
  userDataDir: string
): { ok: true; shells: LowIntegrityShells } | { ok: false; detail: string } {
  const paths = lowIntegrityShellPaths(userDataDir)
  try {
    mkdirSync(paths.dir, { recursive: true })
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  const cmd = lowCopy(win32.join(systemRoot(), 'System32', 'cmd.exe'), paths.cmd)
  if (!cmd.ok) return cmd
  // The full path: Git Bash puts its own whoami first on PATH, and MSYS
  // programs cannot start at low integrity.
  const whoami = win32.join(systemRoot(), 'System32', 'whoami.exe')
  // One verbatim line, as lowIntegrityArgv builds them: Node would escape the
  // quotes with backslashes, which cmd does not read.
  const probe = spawnSync(paths.cmd, ['/d', '/s', '/c', `""${whoami}" /groups /fo csv"`], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    windowsVerbatimArguments: true,
    argv0: 'cmd'
  })
  if (probe.error || !(probe.stdout ?? '').includes(LOW_INTEGRITY_SID)) {
    return {
      ok: false,
      detail: probe.error ? probe.error.message : 'a command started from the low-integrity copy of cmd did not run at low integrity'
    }
  }
  const ps = lowCopy(win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), paths.powershell)
  return { ok: true, shells: { cmd: paths.cmd, powershell: ps.ok ? paths.powershell : null } }
}

type LabelRecord = Record<string, { path: string; level: 'low' | 'medium'; birthtimeMs: number }>

function recordPath(userDataDir: string): string {
  return win32.join(lowIntegrityShellPaths(userDataDir).dir, 'labels.json')
}

function readRecord(userDataDir: string): LabelRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordPath(userDataDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as LabelRecord) : {}
  } catch {
    return {}
  }
}

function writeRecord(userDataDir: string, record: LabelRecord): void {
  try {
    mkdirSync(lowIntegrityShellPaths(userDataDir).dir, { recursive: true })
    writeFileSync(recordPath(userDataDir), JSON.stringify(record, null, 2), 'utf8')
  } catch (err) {
    logger.warn('sandbox label record not saved', { scope: 'sandbox', err })
  }
}

export type IcaclsRunner = (args: string[]) => Promise<{ ok: boolean; detail: string }>

const runIcacls: IcaclsRunner = (args) =>
  new Promise((resolve) => {
    execFile(icaclsPath(), args, { timeout: ICACLS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `/C` keeps going past a file it cannot change (one held open elsewhere);
      // a failure on the folder itself is what makes the label missing.
      resolve(err ? { ok: false, detail: `${stderr || stdout || err.message}`.trim().split(/\r?\n/)[0] ?? '' } : { ok: true, detail: '' })
    })
  })

/** One labelling pass at a time: two commands starting together must not both walk the same tree. */
let labelling: Promise<void> = Promise.resolve()

/**
 * Apply a label plan, skipping paths labelled before and not made anew since.
 * The low temp folder is created here: a label needs something to sit on.
 * Throws with the first failure, so the command is refused, not run unconfined.
 */
export function applyWindowsLabels(
  userDataDir: string,
  homeDir: string,
  plan: readonly IntegrityLabel[],
  run: IcaclsRunner = runIcacls
): Promise<void> {
  const next = labelling.then(async () => {
    mkdirSync(lowIntegrityTempDir(homeDir), { recursive: true })
    const record = readRecord(userDataDir)
    let changed = false
    try {
      for (const label of plan) {
        let stat
        try {
          stat = statSync(label.path)
        } catch {
          continue
        }
        const key = label.path.toLowerCase()
        const known = record[key]
        if (known && known.level === label.level && known.birthtimeMs === stat.birthtimeMs) continue
        const started = Date.now()
        const res = await run(icaclsLabelArgs(label, stat.isDirectory()))
        if (!res.ok) throw new Error(`could not label ${label.path} for the sandbox${res.detail ? `: ${res.detail}` : ''}`)
        record[key] = { path: label.path, level: label.level, birthtimeMs: stat.birthtimeMs }
        changed = true
        logger.info('sandbox labelled a folder', {
          scope: 'sandbox',
          path: label.path,
          level: label.level,
          ms: Date.now() - started
        })
      }
    } finally {
      if (changed) writeRecord(userDataDir, record)
    }
  })
  labelling = next.catch(() => {})
  return next
}

/** `path` is `root` or inside it, compared the way Windows compares paths. */
function isAtOrUnder(path: string, root: string): boolean {
  const p = path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const r = root.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return p === r || p.startsWith(`${r}\\`)
}

/**
 * Put back what the sandbox labelled low: medium is what every unlabelled file
 * already is. Called when the sandbox is turned off, and with `under` when a
 * workspace is removed: its folder kept the low label, so any low-integrity
 * process could write it, until the setting was switched off. Best effort;
 * paths that could not be changed stay in the record for the next try.
 */
export function restoreWindowsLabels(
  userDataDir: string,
  run: IcaclsRunner = runIcacls,
  under?: string
): Promise<void> {
  const next = labelling.then(async () => {
    const record = readRecord(userDataDir)
    const left: LabelRecord = {}
    for (const [key, entry] of Object.entries(record)) {
      if (under && !isAtOrUnder(entry.path, under)) {
        left[key] = entry
        continue
      }
      if (entry.level !== 'low') continue
      let isDirectory: boolean
      try {
        isDirectory = statSync(entry.path).isDirectory()
      } catch {
        continue
      }
      const res = await run(icaclsLabelArgs({ path: entry.path, level: 'medium' }, isDirectory))
      if (!res.ok) left[key] = entry
    }
    writeRecord(userDataDir, left)
  })
  labelling = next.catch(() => {})
  return next
}

/** Write a script the low shell will run, and sweep scripts older than a day. */
export function writeSandboxScript(homeDir: string, extension: '.ps1', text: string): string {
  const dir = win32.join(lowIntegrityTempDir(homeDir), 'scripts')
  mkdirSync(dir, { recursive: true })
  try {
    const cutoff = Date.now() - SCRIPT_MAX_AGE_MS
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('vyotiq-command-')) continue
      const file = win32.join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      } catch {
        /* in use or gone */
      }
    }
  } catch {
    /* sweeping is best effort */
  }
  const file = win32.join(dir, sandboxScriptName(extension))
  writeFileSync(file, text, 'utf8')
  return file
}
