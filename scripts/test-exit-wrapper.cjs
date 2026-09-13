// Runs vitest, waits for the summary line, then force-kills the whole process
// tree and maps the outcome to vitest's real exit code.
//
// Why: on Windows, a full `vitest run` here used to print its summary and then
// hang forever — an orphaned tinypool fork worker holding an open IPC channel
// kept the event loop alive, and vitest's own force-exit never fired.
//
// Primary fix is now vitest.config.ts `teardownTimeout` (tinypool's
// `terminateTimeout`), which terminates a worker that will not shut down on its
// own. This wrapper stays only as a safety net: it still catches the case
// where vitest itself wedges before printing a summary, and it maps a
// summary-then-hang to a non-zero code instead of hanging CI.
//
// HANG_EXIT (86) distinguishes a summary-then-hang from a real failure so CI
// could optionally fail on it.

const { spawn } = require('child_process')

// Vitest's own teardownTimeout (15s) now handles the common case, so this
// grace period only has to cover the hand-off, not the whole teardown.
const TEST_EXIT_GRACE_MS = Number(process.env.TEST_EXIT_GRACE_MS ?? 20_000)
const HANG_EXIT = 86

// Vitest lives under .pnpm on this machine (no hoisted node_modules/vitest).
const { createRequire } = require('module')
const req = createRequire(__filename)
const vitestPkgPath = req.resolve('vitest/package.json')
const vitestDir = vitestPkgPath.slice(0, vitestPkgPath.lastIndexOf('package.json'))
const vitestEntry = require('path').join(vitestDir, 'vitest.mjs')

// Forward the caller's stdout/stderr straight through so vitest output is
// visible live (piping both into memory stalled a single-file run for 7+
// minutes once; pass-through keeps output flowing and the hang detection
// reads the tee'd copy below).
const child = spawn(
  process.execPath,
  [vitestEntry, 'run', '--reporter=dot', ...process.argv.slice(2)],
  { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, shell: false }
)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })

// Vitest's default reporter prints " Duration  123.45s" in the final summary.
let summarySeenAt = 0
const start = Date.now()
const probe = setInterval(() => {
  const now = Date.now()
  if (!summarySeenAt && /Duration\s+[\d.]+(ms|s)|Test Files\s+\d+/.test(out)) {
    summarySeenAt = now
  }
  // Safety valve: even without a summary, don't wait forever.
  if (!summarySeenAt && now - start > 40 * 60 * 1000) {
    finish(true, 1, 'no summary after 40min; killing tree')
  }
  if (summarySeenAt && now - summarySeenAt > TEST_EXIT_GRACE_MS) {
    finish(true, 0, 'summary printed but process did not exit in grace period')
  }
}, 1_000)

function finish(hang, fallbackCode, reason) {
  clearInterval(probe)
  if (hang) {
    console.log(`\n[vyotiq-test] ${reason}`)
    console.log('[vyotiq-test] killing vitest process tree (Windows teardown hang workaround)')
  }
  // Derive the real result from the output before killing: the summary line
  // "Tests  N failed" means the suite genuinely failed.
  const failed = /Tests\s+\d+\s+failed/.test(out)
  const code = failed ? 1 : fallbackCode
  // taskkill /T kills the tree: vitest parent + tinypool fork workers.
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    shell: false
  })
  killer.on('error', () => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    done(code)
  })
  killer.on('close', () => done(code))
}

let finished = false
function done(code) {
  if (finished) return
  finished = true
  if (code === HANG_EXIT) process.exit(code)
  process.exit(code)
}

child.on('exit', (code) => {
  clearInterval(probe)
  // Natural exit: pass through vitest's code (null => signal-killed).
  done(code ?? 1)
})
