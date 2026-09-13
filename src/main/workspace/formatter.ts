import { existsSync, lstatSync } from 'fs'
import { extname, join } from 'path'
import { execFile as execFileCallback } from 'child_process'
import spawn from 'cross-spawn'
import { promisify } from 'util'
import type {
  WorkspaceFormatFileResult,
  WorkspaceFormatterStatus
} from '../../shared/ipc'
import { isSafeWorkspaceRelPath } from '../../shared/utils/workspacePath'

const execFile = promisify(execFileCallback)
const FORMAT_TIMEOUT_MS = 10_000
const FORMAT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024
const FORMATTER_PROBE_TIMEOUT_MS = 2_000

type Formatter = {
  tool: string
  executable: string
  args: (path: string) => string[]
}

const PRETTIER_EXTENSIONS = new Set([
  '.css',
  '.graphql',
  '.gql',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.json5',
  '.jsonc',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.scss',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml'
])

function localExecutable(workspacePath: string, command: string): string | null {
  const bin = join(workspacePath, 'node_modules', '.bin')
  const names =
    process.platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command]
  for (const name of names) {
    const candidate = join(bin, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isRegularWorkspaceFile(workspacePath: string, path: string): boolean {
  if (!isSafeWorkspaceRelPath(path)) return false
  try {
    return lstatSync(join(workspacePath, ...path.split('/'))).isFile()
  } catch {
    return false
  }
}

async function pathExecutable(command: string): Promise<string | null> {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const { stdout } = await execFile(lookup, [command], {
      encoding: 'utf8',
      timeout: FORMATTER_PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    )
  } catch {
    return null
  }
}

async function detectFormatter(workspacePath: string, path: string): Promise<Formatter | null> {
  if (!isSafeWorkspaceRelPath(path)) return null
  const extension = extname(path).toLowerCase()
  if (!PRETTIER_EXTENSIONS.has(extension)) return null

  const prettier =
    localExecutable(workspacePath, 'prettier') ?? (await pathExecutable('prettier'))
  if (prettier) {
    return {
      tool: 'Prettier',
      executable: prettier,
      args: (relPath) => ['--stdin-filepath', relPath]
    }
  }

  const biome = localExecutable(workspacePath, 'biome') ?? (await pathExecutable('biome'))
  if (biome) {
    return {
      tool: 'Biome',
      executable: biome,
      args: (relPath) => ['format', '--stdin-file-path', relPath]
    }
  }

  return null
}

async function runFormatter(
  formatter: Formatter,
  workspacePath: string,
  path: string,
  content: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(formatter.executable, formatter.args(path), {
      cwd: workspacePath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`Formatter timed out after ${FORMAT_TIMEOUT_MS}ms`))
    }, FORMAT_TIMEOUT_MS)

    const finish = (error: Error | null, output = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(output)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk.toString(), 'utf8')
      if (outputBytes > FORMAT_OUTPUT_MAX_BYTES) {
        child.kill()
        finish(new Error('Formatter output exceeded the editor limit'))
        return
      }
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString().slice(0, 4_096)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code === 0) {
        finish(null, stdout)
      } else {
        const detail = stderr.trim() || `Formatter exited with code ${code ?? 'unknown'}`
        finish(new Error(detail))
      }
    })
    child.stdin?.end(content)
  })
}

export async function workspaceFormatterStatus(
  workspacePath: string,
  path: string
): Promise<WorkspaceFormatterStatus> {
  if (!isSafeWorkspaceRelPath(path)) {
    return { kind: 'unavailable', detail: 'Path is outside the workspace' }
  }
  const formatter = await detectFormatter(workspacePath, path)
  return formatter
    ? { kind: 'available', tool: formatter.tool }
    : {
        kind: 'unavailable',
        detail: 'No installed Prettier or Biome formatter supports this file.'
      }
}

export async function formatWorkspaceFile(
  workspacePath: string,
  path: string,
  content: string
): Promise<WorkspaceFormatFileResult> {
  if (!isRegularWorkspaceFile(workspacePath, path)) {
    return {
      kind: 'unavailable',
      detail: 'Formatter requires an existing regular workspace file.'
    }
  }
  const formatter = await detectFormatter(workspacePath, path)
  if (!formatter) {
    return {
      kind: 'unavailable',
      detail: 'No installed Prettier or Biome formatter supports this file.'
    }
  }
  const formatted = await runFormatter(formatter, workspacePath, path, content)
  if (formatted.length > FORMAT_OUTPUT_MAX_BYTES) {
    throw new Error('Formatter output exceeded the editor limit')
  }
  return formatted === content
    ? { kind: 'unchanged', content, tool: formatter.tool }
    : { kind: 'formatted', content: formatted, tool: formatter.tool }
}
