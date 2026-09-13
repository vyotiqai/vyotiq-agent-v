import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import { CRASH_DEDUPE_KEY } from '../../shared/ipc'
import { publishLifecycleNotification } from '../notifications/bus'

/** Decode Windows exit codes as unsigned NTSTATUS hex for crash logs. */
export function formatWindowsExitCode(exitCode: number): string | undefined {
  if (process.platform !== 'win32') return undefined
  const unsigned = exitCode >>> 0
  return `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`
}

/** Reasons where reloading the renderer is safe and usually restores the UI. */
export function shouldReloadRendererAfterCrash(reason: string): boolean {
  return (
    reason === 'crashed' ||
    reason === 'oom' ||
    reason === 'memory-eviction' ||
    reason === 'launch-failed'
  )
}

export const RENDERER_RELOAD_COOLDOWN_MS = 10_000
export const MAX_RENDERER_RELOADS = 3
export const RENDERER_HEALTHY_RESET_MS = 60_000

export type RendererReloadPlan =
  | { action: 'give-up' }
  | { action: 'skip-pending' }
  | { action: 'reload'; waitMs: number }

export function planRendererReload(input: {
  now: number
  lastReloadAt: number
  reloadCount: number
  pending: boolean
}): RendererReloadPlan {
  if (input.reloadCount >= MAX_RENDERER_RELOADS) return { action: 'give-up' }
  if (input.pending) return { action: 'skip-pending' }
  const elapsed = input.lastReloadAt === 0 ? RENDERER_RELOAD_COOLDOWN_MS : input.now - input.lastReloadAt
  const waitMs = Math.max(0, RENDERER_RELOAD_COOLDOWN_MS - elapsed)
  return { action: 'reload', waitMs }
}

/** Count Crashpad minidump files currently on disk (best-effort). */
export function countCrashpadReports(crashDumpsDir: string): number {
  const reportsDir = join(crashDumpsDir, 'reports')
  if (!existsSync(reportsDir)) return 0
  try {
    return readdirSync(reportsDir).filter((name) => /\.dmp$/i.test(name)).length
  } catch {
    return 0
  }
}

/** Keep the newest renderer minidumps; each dump measured ~43 MB in the field. */
export const MAX_CRASHPAD_REPORTS = 5

/** Delete Crashpad minidumps older than the newest `keep`; best-effort, never throws. */
export function pruneCrashpadReports(crashDumpsDir: string, keep = MAX_CRASHPAD_REPORTS): number {
  if (keep <= 0) return 0
  const reportsDir = join(crashDumpsDir, 'reports')
  if (!existsSync(reportsDir)) return 0
  try {
    const dumps = readdirSync(reportsDir)
      .filter((name) => /\.dmp$/i.test(name))
      .map((name) => {
        const full = join(reportsDir, name)
        try {
          return { full, mtimeMs: statSync(full).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { full: string; mtimeMs: number } => entry != null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    let removed = 0
    for (const entry of dumps.slice(keep)) {
      try {
        unlinkSync(entry.full)
        removed += 1
      } catch {
        // Locked or already gone — leave it for the next boot.
      }
    }
    return removed
  } catch {
    return 0
  }
}

/** Redact workspace paths from a renderer URL before logging. */
export function sanitizeCrashUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'file:') return 'file://[app]'
    if (parsed.protocol === 'devtools:') return 'devtools:'
    return `${parsed.protocol}//${parsed.host || '[app]'}`
  } catch {
    return trimmed.includes(':\\') || trimmed.startsWith('/') ? '[url]' : trimmed.slice(0, 120)
  }
}

export type CrashSnippetKind = 'renderer' | 'child'

export type CrashSnippet = {
  at: string
  kind: CrashSnippetKind
  reason: string
  exitCode?: number
  exitCodeHex?: string
  processType?: string
  name?: string
  url?: string
  crashDumpCount?: number
  /** Same-signature records suppressed by the recorder between this and the prior entry. */
  suppressedRepeats?: number
}

export type CrashRecoveryPending = {
  at: string
  reason: string
  exitCode?: number
  exitCodeHex?: string
}

type CrashHistoryFile = {
  snippets: CrashSnippet[]
  pendingRecovery: CrashRecoveryPending | null
  /** Bumped when log→history backfill schema changes; 1 = initial RENDERER/CHILD parse. */
  backfillVersion?: number
}

export const MAX_CRASH_SNIPPETS = 8
export const CRASH_BACKFILL_VERSION = 1

/** Test-only override so unit tests avoid importing Electron. */
let historyPathOverride: string | null = null

export function setCrashHistoryPathForTests(path: string | null): void {
  historyPathOverride = path
}

/** Same-signature repeats inside this window skip the sync read+write cycle. */
export const SNIPPET_REPEAT_SUPPRESS_MS = 30_000
let lastSnippetSignature = ''
let lastSnippetLoggedAt = 0
let snippetSuppressedCount = 0

/** Test hook — clears the in-memory snippet dedupe state. */
export function resetCrashSnippetDedupeForTests(): void {
  lastSnippetSignature = ''
  lastSnippetLoggedAt = 0
  snippetSuppressedCount = 0
}

function historyPath(): string {
  if (historyPathOverride) return historyPathOverride
  // Lazy require keeps pure helpers importable without Electron in unit tests.
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'crash-history.json')
}

function emptyHistory(): CrashHistoryFile {
  return { snippets: [], pendingRecovery: null }
}

function readHistory(): CrashHistoryFile {
  const path = historyPath()
  if (!existsSync(path)) return emptyHistory()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CrashHistoryFile>
    const snippets = Array.isArray(raw.snippets)
      ? raw.snippets.filter(
          (s): s is CrashSnippet =>
            Boolean(s) &&
            typeof s === 'object' &&
            typeof (s as CrashSnippet).at === 'string' &&
            typeof (s as CrashSnippet).reason === 'string' &&
            ((s as CrashSnippet).kind === 'renderer' || (s as CrashSnippet).kind === 'child')
        )
      : []
    const pending =
      raw.pendingRecovery &&
      typeof raw.pendingRecovery === 'object' &&
      typeof raw.pendingRecovery.at === 'string' &&
      typeof raw.pendingRecovery.reason === 'string'
        ? raw.pendingRecovery
        : null
    const backfillVersion =
      typeof raw.backfillVersion === 'number' && Number.isFinite(raw.backfillVersion)
        ? raw.backfillVersion
        : undefined
    return { snippets, pendingRecovery: pending, ...(backfillVersion != null ? { backfillVersion } : {}) }
  } catch {
    return emptyHistory()
  }
}

function writeHistory(next: CrashHistoryFile): void {
  try {
    atomicWriteJson(historyPath(), next, 0o600)
  } catch {
    // Best-effort — crash path must not throw.
  }
}

function snippetDedupeKey(snippet: CrashSnippet): string {
  return [
    snippet.kind,
    snippet.at,
    snippet.reason,
    snippet.exitCode ?? '',
    snippet.processType ?? '',
    snippet.name ?? ''
  ].join('\0')
}

/** Append a crash snippet (keeps the newest MAX_CRASH_SNIPPETS). */
export function recordCrashSnippet(snippet: CrashSnippet): void {
  // A renderer error storm (React #185) bridges one log record per throw into
  // this hook; a synchronous read+write per record saturates the main thread.
  // Same-signature repeats inside the suppress window only bump the in-memory
  // count, recorded on the next persisted entry.
  const now = Date.now()
  const signature = [
    snippet.kind,
    snippet.reason,
    snippet.exitCode ?? '',
    snippet.processType ?? '',
    snippet.name ?? ''
  ].join('\0')
  if (
    signature === lastSnippetSignature &&
    now - lastSnippetLoggedAt < SNIPPET_REPEAT_SUPPRESS_MS
  ) {
    snippetSuppressedCount += 1
    return
  }
  const suppressed = snippetSuppressedCount
  snippetSuppressedCount = 0
  lastSnippetSignature = signature
  lastSnippetLoggedAt = now
  const history = readHistory()
  const recorded: CrashSnippet =
    suppressed > 0 ? { ...snippet, suppressedRepeats: suppressed } : snippet
  history.snippets = [recorded, ...history.snippets].slice(0, MAX_CRASH_SNIPPETS)
  writeHistory(history)
}

/** Mark that the renderer will auto-reload so the next boot can show a banner. */
export function markRendererRecoveryPending(pending: CrashRecoveryPending): void {
  const history = readHistory()
  history.pendingRecovery = pending
  writeHistory(history)
  const code = pending.exitCodeHex ?? (pending.exitCode != null ? String(pending.exitCode) : '')
  publishLifecycleNotification({
    source: 'system',
    kind: 'crash',
    title: 'UI recovered after a crash',
    body: code ? `${pending.reason} · ${code}` : pending.reason,
    dedupeKey: CRASH_DEDUPE_KEY,
    action: { type: 'open_settings', section: 'general' }
  })
}

/** Read-and-clear the post-reload recovery banner payload. */
export function consumeRendererRecoveryPending(): CrashRecoveryPending | null {
  const history = readHistory()
  const pending = history.pendingRecovery
  if (!pending) return null
  history.pendingRecovery = null
  writeHistory(history)
  return pending
}

/** Recent crash snippets for Settings → General (does not clear). */
export function listCrashSnippets(): CrashSnippet[] {
  return readHistory().snippets
}

export type CrashDiagnosticsSnapshot = {
  snippets: CrashSnippet[]
  pendingRecovery: CrashRecoveryPending | null
}

export function getCrashDiagnosticsSnapshot(): CrashDiagnosticsSnapshot {
  const history = readHistory()
  return {
    snippets: history.snippets,
    pendingRecovery: history.pendingRecovery
  }
}

const LOG_LINE_START =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s+\[(\w+)\]\s+/

function parseLogTimestamp(stamp: string): string {
  const normalized = stamp.includes('.') ? stamp.replace(' ', 'T') : `${stamp.replace(' ', 'T')}.000`
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function extractQuoted(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`${key}:\\s*'((?:\\\\'|[^'])*)'`))
  return m?.[1]?.replace(/\\'/g, "'")
}

function extractNumber(block: string, key: string): number | undefined {
  const m = block.match(new RegExp(`${key}:\\s*(-?\\d+)`))
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/** Parse RENDERER_CRASH / CHILD_PROCESS_CRASH lines from an electron-log file. */
export function parseCrashSnippetsFromLogText(text: string): CrashSnippet[] {
  const lines = text.split(/\r?\n/)
  const out: CrashSnippet[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const start = line.match(LOG_LINE_START)
    if (!start) continue
    const isRenderer = /Renderer process gone/.test(line)
    const isChild = /Child process gone/.test(line)
    if (!isRenderer && !isChild) continue

    const chunks = [line.slice(start[0].length)]
    let j = i + 1
    // Multi-line util.inspect objects continue until the next log line start.
    while (j < lines.length && !LOG_LINE_START.test(lines[j] ?? '')) {
      chunks.push(lines[j] ?? '')
      j++
    }
    const block = chunks.join('\n')
    if (!/RENDERER_CRASH|CHILD_PROCESS_CRASH/.test(block)) continue
    // Skip intentional teardown lines that lack crash codes.
    const reason = extractQuoted(block, 'reason')
    if (!reason || reason === 'killed' || reason === 'clean-exit') continue

    const kind: CrashSnippetKind = /CHILD_PROCESS_CRASH/.test(block) ? 'child' : 'renderer'
    const exitCode = extractNumber(block, 'exitCode')
    const exitCodeHex = extractQuoted(block, 'exitCodeHex')
    const processType = extractQuoted(block, 'processType')
    const name = extractQuoted(block, 'name')
    const url = extractQuoted(block, 'url')
    const crashDumpCount = extractNumber(block, 'crashDumpCount')

    out.push({
      at: parseLogTimestamp(start[1]),
      kind,
      reason,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitCodeHex ? { exitCodeHex } : {}),
      ...(processType ? { processType } : {}),
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(crashDumpCount !== undefined ? { crashDumpCount } : {})
    })
    i = j - 1
  }

  return out
}

/**
 * Extract a React error-boundary crash snippet from one bridged renderer log
 * record. electron-log hands hooks the raw arguments as
 * `data: ['[renderer] <message>', { code, err, ... }]` — main-side
 * `Renderer process gone` records carry the `[main] ` prefix and never match.
 * Returns null for every non-boundary record so live wiring stays a single
 * cheap check per log record.
 */
export function rendererBoundaryCrashFromLogMessage(message: {
  data?: unknown[]
  date?: unknown
}): CrashSnippet | null {
  const line = message.data?.[0]
  if (typeof line !== 'string' || !line.startsWith('[renderer] ')) return null
  if (!line.includes('Renderer crash') && !line.includes('React maximum update depth')) return null
  const meta = message.data?.[1] as { code?: unknown; err?: { message?: unknown } } | undefined
  if (meta?.code !== 'RENDERER_CRASH' && meta?.code !== 'REACT_185') return null
  const at = message.date instanceof Date ? message.date : new Date()
  const reason =
    typeof meta.err?.message === 'string' && meta.err.message
      ? meta.err.message
      : line.slice('[renderer] '.length)
  return { at: at.toISOString(), kind: 'renderer', reason }
}

/**
 * One-shot: seed crash-history.json from recent log crash lines.
 * No-ops when `backfillVersion` is already {@link CRASH_BACKFILL_VERSION}.
 * @returns number of snippets newly added from the log
 */
export function backfillCrashSnippetsFromLog(logPath: string): number {
  const history = readHistory()
  if ((history.backfillVersion ?? 0) >= CRASH_BACKFILL_VERSION) return 0

  let parsed: CrashSnippet[] = []
  if (existsSync(logPath)) {
    try {
      const text = readFileSync(logPath, 'utf8')
      parsed = parseCrashSnippetsFromLogText(text)
    } catch {
      parsed = []
    }
  }

  const seen = new Set(history.snippets.map(snippetDedupeKey))
  const added: CrashSnippet[] = []
  // Newest first (log order is chronological; reverse so recent crashes win the cap).
  for (const snippet of [...parsed].reverse()) {
    const key = snippetDedupeKey(snippet)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(snippet)
  }

  const snippets = [...added, ...history.snippets].slice(0, MAX_CRASH_SNIPPETS)
  writeHistory({
    snippets,
    pendingRecovery: history.pendingRecovery,
    backfillVersion: CRASH_BACKFILL_VERSION
  })
  return added.length
}
