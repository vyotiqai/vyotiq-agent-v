import { spawn, spawnSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { shell } from 'electron'
import type { PreferredEditor } from '../../shared/ipc'
import { logger } from '../../shared/logger'

/**
 * Open a file (at a line) or a folder in the person's own editor: VS Code,
 * Cursor, Windsurf, Zed, Sublime Text or a JetBrains IDE, through the command
 * each installs on PATH. `auto` takes the first one found; `system` hands the
 * path to the OS default app. Nothing in the app could do this before — a
 * task's file or worktree could only be revealed in the file manager.
 */

type EditorSpec = {
  /** Commands to look for on PATH, in order. */
  bins: readonly string[]
  /** Arguments to open `path`, at `line`/`column` when given. */
  args: (path: string, at?: { line: number; column?: number }) => string[]
}

const goto = (path: string, at?: { line: number; column?: number }): string[] =>
  at ? ['--goto', `${path}:${at.line}${at.column ? `:${at.column}` : ''}`] : [path]
const colon = (path: string, at?: { line: number; column?: number }): string[] =>
  at ? [`${path}:${at.line}${at.column ? `:${at.column}` : ''}`] : [path]
const jetbrains = (path: string, at?: { line: number; column?: number }): string[] =>
  at ? ['--line', String(at.line), ...(at.column ? ['--column', String(at.column)] : []), path] : [path]

export const EDITORS: Record<Exclude<PreferredEditor, 'auto' | 'system'>, EditorSpec> = {
  vscode: { bins: ['code', 'code-insiders'], args: goto },
  cursor: { bins: ['cursor'], args: goto },
  windsurf: { bins: ['windsurf'], args: goto },
  zed: { bins: ['zed', 'zeditor'], args: colon },
  sublime: { bins: ['subl'], args: colon },
  webstorm: { bins: ['webstorm', 'webstorm64'], args: jetbrains },
  idea: { bins: ['idea', 'idea64'], args: jetbrains },
  pycharm: { bins: ['pycharm', 'pycharm64', 'charm'], args: jetbrains }
}

/** `auto` looks for these, in this order. */
const AUTO_ORDER: readonly (keyof typeof EDITORS)[] = ['cursor', 'vscode', 'windsurf', 'zed', 'sublime', 'webstorm', 'idea', 'pycharm']

const resolvedBins = new Map<string, string | null>()

/** The full path of a command on PATH (Windows `.cmd` shims included), or null. */
export function findOnPath(bin: string): string | null {
  const cached = resolvedBins.get(bin)
  if (cached !== undefined) return cached
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [bin], { encoding: 'utf8', windowsHide: true, env: process.env })
  const first =
    result.status === 0
      ? (result.stdout ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          // On Windows `where code` lists the extensionless bash script first; the .cmd is what runs.
          .sort((a, b) => Number(/\.(cmd|exe|bat)$/i.test(b)) - Number(/\.(cmd|exe|bat)$/i.test(a)))
          .find(Boolean) ?? null
      : null
  resolvedBins.set(bin, first)
  return first
}

export function resetEditorLookupForTests(): void {
  resolvedBins.clear()
}

/** Which editor `preferred` means on this machine, and its command; null for the OS default. */
export function resolveEditor(preferred: PreferredEditor): { id: keyof typeof EDITORS; bin: string } | null {
  if (preferred === 'system') return null
  const ids = preferred === 'auto' ? AUTO_ORDER : [preferred]
  for (const id of ids) {
    for (const name of EDITORS[id].bins) {
      const bin = findOnPath(name)
      if (bin) return { id, bin }
    }
  }
  return null
}

/** Editors found on this machine, for Settings' picker. */
export function installedEditors(): (keyof typeof EDITORS)[] {
  return AUTO_ORDER.filter((id) => EDITORS[id].bins.some((name) => findOnPath(name)))
}

/** Quote one argument for `cmd.exe /s /c "…"`: paths here carry spaces. */
function cmdQuote(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/** Start the editor detached; resolves once it has spawned (or failed to). */
function launch(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // A Windows `.cmd` shim cannot be spawned directly; cmd runs it, with
    // every argument quoted (the workspace path has spaces).
    const windowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
    const child = windowsShim
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[bin, ...args].map(cmdQuote).join(' ')}"`], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          windowsVerbatimArguments: true
        })
      : spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export type OpenInEditorResult = { editor: string }

/**
 * Open `absPath` (a file or a folder) in the preferred editor. Falls back to
 * the OS default app when no editor is found, and says which one opened it.
 */
export async function openInEditor(
  absPath: string,
  opts: { preferred: PreferredEditor; line?: number; column?: number }
): Promise<OpenInEditorResult> {
  if (!existsSync(absPath)) throw new Error(`${absPath} does not exist`)
  const isFile = statSync(absPath).isFile()
  const editor = resolveEditor(opts.preferred)
  if (editor) {
    const at = isFile && opts.line && opts.line > 0 ? { line: opts.line, ...(opts.column ? { column: opts.column } : {}) } : undefined
    try {
      await launch(editor.bin, EDITORS[editor.id].args(absPath, at))
      return { editor: editor.id }
    } catch (err) {
      logger.warn('Editor launch failed; using the system default', { scope: 'app', err })
    }
  } else if (opts.preferred !== 'auto' && opts.preferred !== 'system') {
    throw new Error(`${opts.preferred} is not on PATH. Install its command-line launcher, or pick another editor in Settings › General.`)
  }
  const error = await shell.openPath(absPath)
  if (error) throw new Error(error)
  return { editor: 'system' }
}
