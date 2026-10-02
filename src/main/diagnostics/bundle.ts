import { redactSecretsInText } from '../../shared/utils/redactSecrets'
import { scrubString, scrubValue } from '../../shared/utils/scrub'
import { createZip, type ZipEntry } from './zip'

/**
 * The diagnostics bundle: what someone helping with a bug needs, with nothing
 * the person wouldn't hand over. Pure, so tests can read every byte; the
 * export (export.ts) gathers the inputs and writes the file.
 *
 * Redaction runs on everything that goes in, logs included, even though the
 * logger already scrubs what it writes: keys and tokens by shape and by field
 * name, every value of an `env` or `headers` map (an MCP server's or a custom
 * provider's, secret-shaped or not), the home folder as `~`, absolute paths as
 * their last segment, and the account's username wherever else it appears.
 */

export const DIAGNOSTICS_LOG_TAIL_BYTES = 2 * 1024 * 1024
export const REDACTED = '[redacted]'

export type RedactionContext = {
  /** os.homedir(). */
  home: string
  /** os.userInfo().username. */
  username: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The home folder in both slash styles, case-insensitive on Windows-shaped paths. */
function homePattern(home: string): RegExp | null {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed.length < 3) return null
  const parts = trimmed.split(/[\\/]+/).map(escapeRegExp)
  return new RegExp(parts.join(String.raw`(?:\\\\|\\|/)`), 'gi')
}

/** Text with the home folder as `~`, secrets and absolute paths scrubbed, and the username gone. */
export function redactDiagnosticsText(text: string, ctx: RedactionContext): string {
  let out = text
  const home = homePattern(ctx.home)
  if (home) out = out.replace(home, '~')
  out = redactSecretsInText(scrubString(out))
  // Short names ("a", "pi") would eat ordinary words; three letters is the floor.
  if (ctx.username.trim().length >= 3) {
    const name = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(ctx.username.trim())}(?![A-Za-z0-9])`, 'gi')
    out = out.replace(name, '<user>')
  }
  return out
}

/** Keys whose maps hold values a user typed for a server or a gateway: every value goes. */
const VALUE_MAP_KEYS = new Set(['env', 'headers'])

function blankValueMaps(value: unknown, depth: number): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => blankValueMaps(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (VALUE_MAP_KEYS.has(key.toLowerCase()) && field && typeof field === 'object' && !Array.isArray(field)) {
      out[key] = Object.fromEntries(Object.keys(field as Record<string, unknown>).map((k) => [k, REDACTED]))
    } else {
      out[key] = blankValueMaps(field, depth + 1)
    }
  }
  return out
}

function mapStrings(value: unknown, fn: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value)
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, field]) => [key, mapStrings(field, fn, depth + 1)])
  )
}

/**
 * Any JSON-able value as the bundle keeps it: value maps blanked, sensitive
 * field names redacted and paths cut by the logger's scrubber, then the
 * home folder and username taken out of every string left.
 */
export function redactDiagnosticsValue(value: unknown, ctx: RedactionContext): unknown {
  const home = homePattern(ctx.home)
  // The home folder first, while paths are whole: `~/…` survives the path cut.
  const homeless = home ? mapStrings(value, (text) => text.replace(home, '~')) : value
  const scrubbed = scrubValue(blankValueMaps(homeless, 0))
  return mapStrings(scrubbed, (text) => redactDiagnosticsText(text, ctx))
}

/** The last `maxBytes` of a log, starting on a whole line. */
export function logTail(text: string, maxBytes: number = DIAGNOSTICS_LOG_TAIL_BYTES): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return text
  const tail = Buffer.from(text, 'utf8').subarray(bytes - maxBytes).toString('utf8')
  const firstBreak = tail.indexOf('\n')
  return `[… earlier lines left out: the bundle keeps the last ${Math.round(maxBytes / 1024)} KB]\n${firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail}`
}

export type DiagnosticsInput = {
  now: Date
  /** App version, OS, arch, Electron/Node/Chrome versions and the like. */
  system: Record<string, unknown>
  settings: unknown
  crashes: unknown
  /** Memory and load snapshots; a section that could not be read carries its error. */
  perf: unknown
  logs: Array<{ name: string; text: string }>
  ctx: RedactionContext
}

function jsonEntry(name: string, value: unknown, ctx: RedactionContext): ZipEntry {
  return { name, data: Buffer.from(`${JSON.stringify(redactDiagnosticsValue(value, ctx), null, 2)}\n`, 'utf8') }
}

/** The files in the bundle, in order, redacted. */
export function buildDiagnosticsEntries(input: DiagnosticsInput): ZipEntry[] {
  const { ctx } = input
  const logNames = input.logs.map((log) => `logs/${log.name.replace(/[\\/]/g, '_')}`)
  const readme = [
    'Vyotiq diagnostics',
    `Made ${input.now.toISOString()}`,
    '',
    'system.json    app, Electron, Node and OS versions, CPU and memory',
    'settings.json  your settings; keys, tokens, env and header values redacted',
    'crashes.json   recent renderer and child-process exits',
    'perf.json      memory per process and the main process load',
    ...logNames.map((name) => `${name.padEnd(14)} the end of the app log`),
    '',
    'Secrets, tokens and keys are replaced with [redacted]; your home folder',
    'reads as ~ and your username as <user>. No task contents are included',
    'beyond what the app log itself records.',
    ''
  ].join('\n')
  return [
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    jsonEntry('system.json', input.system, ctx),
    jsonEntry('settings.json', input.settings, ctx),
    jsonEntry('crashes.json', input.crashes, ctx),
    jsonEntry('perf.json', input.perf, ctx),
    ...input.logs.map((log, i) => ({
      name: logNames[i]!,
      data: Buffer.from(redactDiagnosticsText(logTail(log.text), ctx), 'utf8')
    }))
  ]
}

export function buildDiagnosticsZip(input: DiagnosticsInput): { zip: Buffer; files: string[] } {
  const entries = buildDiagnosticsEntries(input)
  return { zip: createZip(entries, input.now), files: entries.map((entry) => entry.name) }
}

/** `vyotiq-diagnostics-20261002-1430.zip`, local time. */
export function diagnosticsFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `vyotiq-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
}
