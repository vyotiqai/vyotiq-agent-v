/**
 * The crash backfill seeds Diagnostics from the log, but rotation now keeps 5
 * numbered generations (`vyotiq.old.1.log` … `vyotiq.old.5.log`), so a crash
 * that rotated out of `vyotiq.log` was exported by diagnostics/export.ts and
 * yet never shown in the panel.
 *
 * Every fixture here is a `mkdtempSync` temp dir and every history write is
 * redirected with `setCrashHistoryPathForTests`, so no run of this suite can
 * touch the real `%APPDATA%\vyotiq`. `@main/logging/init.ts` is deliberately
 * NOT imported — it calls `log.initialize()` / `ensureLogsDirectory()`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { backfillCrashSnippetsFromLog, listCrashSnippets, setCrashHistoryPathForTests } from '@main/logging/crashDiagnostics'

const RENDERER_CRASH_LINE =
  "[2026-08-01 19:42:35.771] [error] [main] Renderer process gone { code: 'RENDERER_CRASH', reason: 'crashed', exitCode: -1 }"
const CHILD_CRASH_LINES = [
  '[2026-08-02 08:10:00.100] [error] [main] Child process gone {',
  "  code: 'CHILD_PROCESS_CRASH',",
  "  processType: 'GPU',",
  "  reason: 'oom',",
  '  exitCode: -1,',
  "  exitCodeHex: '0xFFFFFFFF'",
  '}'
]

describe('backfillCrashSnippetsFromLog across rotated generations', () => {
  let dir: string

  afterEach(() => {
    setCrashHistoryPathForTests(null)
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function makeDir(tag: string): { logsDir: string; liveLogPath: string } {
    dir = mkdtempSync(join(tmpdir(), `vyotiq-crash-gen-${tag}-`))
    const logsDir = join(dir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    setCrashHistoryPathForTests(join(dir, 'crash-history.json'))
    return { logsDir, liveLogPath: join(logsDir, 'vyotiq.log') }
  }

  it('backfills a crash that survives only in vyotiq.old.1.log', () => {
    const { logsDir, liveLogPath } = makeDir('only-archive')
    writeFileSync(join(logsDir, 'vyotiq.old.1.log'), RENDERER_CRASH_LINE, 'utf8')
    // The live log still exists but carries no crash — the rotated line is the
    // only evidence, and pre-fix the backfill read the live file alone.
    writeFileSync(liveLogPath, "[2026-08-03 09:00:00.000] [info] [main] Logging initialized\n", 'utf8')

    expect(backfillCrashSnippetsFromLog(liveLogPath)).toBe(1)
    expect(listCrashSnippets()).toHaveLength(1)
    expect(listCrashSnippets()[0]).toMatchObject({
      kind: 'renderer',
      reason: 'crashed',
      exitCode: -1
    })
  })

  it('backfills a crash that rotated past the first generation', () => {
    const { logsDir, liveLogPath } = makeDir('deep-archive')
    writeFileSync(join(logsDir, 'vyotiq.old.3.log'), RENDERER_CRASH_LINE, 'utf8')
    writeFileSync(join(logsDir, 'vyotiq.old.2.log'), '[2026-08-01 12:00:00.000] [info] [main] noise\n', 'utf8')

    expect(backfillCrashSnippetsFromLog(liveLogPath)).toBe(1)
    expect(listCrashSnippets()[0]?.reason).toBe('crashed')
  })

  it('yields one snippet when the same crash line is in two generations', () => {
    const { logsDir, liveLogPath } = makeDir('dup')
    writeFileSync(join(logsDir, 'vyotiq.old.1.log'), RENDERER_CRASH_LINE, 'utf8')
    writeFileSync(liveLogPath, RENDERER_CRASH_LINE, 'utf8')

    expect(backfillCrashSnippetsFromLog(liveLogPath)).toBe(1)
    expect(listCrashSnippets()).toHaveLength(1)
  })

  it('keeps the newest generation first when several hold distinct crashes', () => {
    const { logsDir, liveLogPath } = makeDir('order')
    writeFileSync(join(logsDir, 'vyotiq.old.2.log'), CHILD_CRASH_LINES.join('\n'), 'utf8')
    writeFileSync(join(logsDir, 'vyotiq.old.1.log'), RENDERER_CRASH_LINE, 'utf8')
    writeFileSync(liveLogPath, "[2026-08-05 09:00:00.000] [info] [main] nothing here\n", 'utf8')

    expect(backfillCrashSnippetsFromLog(liveLogPath)).toBe(2)
    const snippets = listCrashSnippets()
    expect(snippets.map((s) => s.kind)).toEqual(['renderer', 'child'])
  })

  it('does not re-parse generations once backfillVersion is recorded', () => {
    const { logsDir, liveLogPath } = makeDir('gate')
    writeFileSync(liveLogPath, '[2026-08-01 12:00:00.000] [info] [main] noise\n', 'utf8')

    // First run: nothing to seed, but the version is stamped.
    expect(backfillCrashSnippetsFromLog(liveLogPath)).toBe(0)

    // A crash appears in an older generation afterwards (e.g. the file was
    // copied in). The one-shot gate must keep the boot cost at zero.
    writeFileSync(join(logsDir, 'vyotiq.old.1.log'), RENDERER_CRASH_LINE, 'utf8')
    expect(backfillCrashSnippetsFromLog(liveLogPath)).toBe(0)
    expect(listCrashSnippets()).toHaveLength(0)
  })
})
