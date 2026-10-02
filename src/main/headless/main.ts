import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { isatty } from 'tty'
import { format } from 'util'
import { app } from 'electron'
import log from 'electron-log/main'
import { ProviderIdSchemaAny, type ProviderIdAny } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { initMainLogging } from '../logging/init'
import { getSettings } from '../settings/settings'
import { widenHappyEyeballsWindow } from '../net/happyEyeballs'
import { applyEarlyNodeProxy, applyNetworkSettings } from '../net/proxy'
import { primeLoginShellPath } from '../agent/mcp/binaries'
import { shutdownMcpServers } from '../agent/mcp'
import { flushEgressRunLedgers, startEgressRunLedger } from '../agent/egressRunLedger'
import { disposeAllTerminalSessions } from '../agent/tools/terminalSessions'
import { disposeAllPtySessions } from '../app/ptySessions'
import { closeAgentBrowser } from '../app/agentBrowser'
import { shutdownTokenizerPool } from '../agent/context/tokenizerPool'
import { HEADLESS_USAGE, parseHeadlessArgs, splitModelArg, type HeadlessOptions } from './args'
import { finalOutput, progressLineForEvent, streamJsonForEvent, streamJsonLine, textSummaryLine } from './format'
import { EXIT_INTERRUPTED, EXIT_USAGE } from './outcome'
import { runHeadlessTask, type HeadlessStreamItem } from './runTask'

/**
 * The process side of `Vyotiq --headless`: no window, no tray, no
 * single-instance lock — it runs beside an open app, reading the same
 * settings and keys and writing ordinary run records the app's navigator
 * lists later. Chromium's own profile (cache, cookies, network state) goes
 * to a per-process folder so the two never fight over its locks.
 *
 * stdout carries only the output format; logs go to the log file, and any
 * stray console output from the app's code is moved to stderr.
 */

/** Bounded waits on the way out: a stuck child must not hold the exit. */
const SHUTDOWN_STEP_MS = 5_000

/** The original stdout writer, before console output is moved off it. */
const writeStdout = (text: string): Promise<void> =>
  new Promise((done) => {
    if (!text) return done()
    try {
      process.stdout.write(text, () => done())
    } catch {
      done()
    }
  })

const writeStderr = (text: string): void => {
  try {
    process.stderr.write(text)
  } catch {
    // a closed stderr must not end the run
  }
}

/** Exit now, after stdout has taken what was written to it. */
async function exitWith(code: number, stdoutText = ''): Promise<never> {
  await writeStdout(stdoutText)
  // app.exit skips before-quit; everything that needed flushing was flushed.
  if (app.isReady()) app.exit(code)
  process.exit(code)
}

function sessionRoot(): string {
  return join(app.getPath('userData'), 'headless')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Chromium profile data for this process only. Earlier headless runs' folders
 * are removed once their process is gone — only folders named for a pid,
 * only under our own `headless/` folder.
 */
function isolateChromiumProfile(): string {
  const root = sessionRoot()
  try {
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      const m = /^session-(\d+)$/.exec(name)
      if (!m || Number(m[1]) === process.pid || pidAlive(Number(m[1]))) continue
      rmSync(join(root, name), { recursive: true, force: true })
    }
  } catch {
    // best effort: a folder still held is retried next time
  }
  const dir = join(root, `session-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  // `Local State` holds the OS-sealed key safeStorage decrypts the saved
  // API keys with; a fresh profile would mint a new key and every stored
  // key would read as undecryptable. Copy it — read-only use, and Chromium
  // writes the app's copy atomically.
  const localState = join(app.getPath('userData'), 'Local State')
  if (existsSync(localState)) copyFileSync(localState, join(dir, 'Local State'))
  app.setPath('sessionData', dir)
  return dir
}

/** The app's own code writes to console in places; keep stdout for the output format. */
function moveConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => writeStderr(`${format(...args)}\n`)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  console.warn = toStderr
}

/**
 * Read all of stdin. Electron's main process on Windows sees `process.stdin`
 * end at once even on a pipe (measured), while a plain read of fd 0 gets
 * the data — so read the descriptor, and use the stream only where that
 * read is refused (a non-blocking pipe on POSIX answers EAGAIN).
 */
async function readStdin(): Promise<string> {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    // fall through to the stream
  }
  const stdin = process.stdin
  if (!stdin) return ''
  return new Promise((done, fail) => {
    let text = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      text += chunk
    })
    stdin.on('end', () => done(text))
    stdin.on('error', fail)
    stdin.resume()
  })
}

type Resolved = { prompt: string; workspacePath: string; provider?: ProviderIdAny; model?: string }

async function resolveInputs(options: HeadlessOptions): Promise<Resolved | { error: string }> {
  const workspacePath = resolve(options.cwd ?? process.cwd())
  try {
    if (!statSync(workspacePath).isDirectory()) return { error: `--cwd is not a folder: ${workspacePath}` }
  } catch {
    return { error: `--cwd does not exist: ${workspacePath}` }
  }
  let prompt: string
  switch (options.prompt.kind) {
    case 'text':
      prompt = options.prompt.text
      break
    case 'file':
      try {
        prompt = readFileSync(resolve(options.prompt.path), 'utf8')
      } catch {
        return { error: `Could not read --prompt-file ${options.prompt.path}` }
      }
      break
    case 'stdin':
      prompt = await readStdin()
      break
    case 'auto':
      // isatty on the descriptor: Electron leaves process.stdin.isTTY unset.
      if (isatty(0)) return { error: 'No prompt: pass --prompt, --prompt-file, or pipe it on stdin' }
      prompt = await readStdin()
      break
  }
  if (!prompt.trim()) return { error: 'The prompt is empty' }
  let provider: ProviderIdAny | undefined
  let model: string | undefined
  if (options.model) {
    const split = splitModelArg(options.model, (id) => ProviderIdSchemaAny.safeParse(id).success)
    provider = split.provider as ProviderIdAny | undefined
    model = split.model
  }
  return { prompt: prompt.trim(), workspacePath, provider, model }
}

async function bounded(label: string, task: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<void>((done) => setTimeout(done, SHUTDOWN_STEP_MS).unref?.())
    ])
  } catch (err) {
    logger.warn(`Headless shutdown: ${label} failed`, { scope: 'headless', err })
  }
}

async function shutdown(): Promise<void> {
  await bounded('terminal sessions', disposeAllTerminalSessions)
  await bounded('pty sessions', disposeAllPtySessions)
  await bounded('agent browser', closeAgentBrowser)
  await bounded('tokenizer pool', shutdownTokenizerPool)
  await bounded('egress ledger', flushEgressRunLedgers)
  await bounded('MCP servers', shutdownMcpServers)
}

function writeOutputFile(path: string | undefined, text: string): void {
  if (!path) return
  try {
    writeFileSync(resolve(path), text, 'utf8')
  } catch (err) {
    writeStderr(`Could not write --output-file ${path}: ${String(err)}\n`)
  }
}

/**
 * Called from index.ts, before any window or lock, when argv has
 * `--headless`. Everything up to `whenReady` runs synchronously so the
 * before-ready settings (profile path, GPU) land in time.
 */
export function runHeadlessProcess(argv: readonly string[]): void {
  const parsed = parseHeadlessArgs(argv)
  if (!parsed.ok) {
    writeStderr(`${parsed.error}\n\n${HEADLESS_USAGE}\n`)
    void exitWith(EXIT_USAGE)
    return
  }
  if ('help' in parsed) {
    void exitWith(0, `${HEADLESS_USAGE}\n`)
    return
  }
  const options = parsed.options

  moveConsoleToStderr()
  try {
    isolateChromiumProfile()
  } catch (err) {
    writeStderr(`Could not set up a private browser profile: ${String(err)}\n`)
  }
  // Nothing is drawn; a GPU process would only cost startup time.
  app.disableHardwareAcceleration()
  widenHappyEyeballsWindow()
  try {
    applyEarlyNodeProxy(getSettings().network)
  } catch {
    // unreadable settings: the ready-time apply reports it
  }

  // First Ctrl+C stops the run and reports it; a second one leaves at once.
  const interrupt = new AbortController()
  const onSignal = (): void => {
    if (interrupt.signal.aborted) {
      void exitWith(EXIT_INTERRUPTED)
      return
    }
    writeStderr('Stopping… (Ctrl+C again to quit now)\n')
    interrupt.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  if (process.platform === 'win32') process.on('SIGBREAK', onSignal)

  void app
    .whenReady()
    .then(async () => {
      // The log file has everything; stdout belongs to the output format.
      // electron-log keeps its own handle on the console, so mute the
      // transport itself — before init, which logs a line of its own.
      log.transports.console.writeFn = () => undefined
      initMainLogging()
      log.transports.console.level = false
      startEgressRunLedger()
      if (process.platform === 'darwin') app.dock?.hide()
      try {
        await applyNetworkSettings(getSettings().network)
      } catch (err) {
        logger.warn('Headless: network settings not applied', { scope: 'headless', err })
      }
      await primeLoginShellPath()

      const inputs = await resolveInputs(options)
      if ('error' in inputs) {
        writeStderr(`${inputs.error}\n`)
        return exitWith(EXIT_USAGE)
      }
      logger.info('Headless run starting', {
        scope: 'headless',
        mode: options.mode,
        approval: options.approval,
        output: options.output
      })

      const onItem = (item: HeadlessStreamItem): void => {
        if (options.output === 'stream-json') {
          const line =
            item.type === 'event' ? streamJsonForEvent(item.event) : streamJsonLine(item as unknown as Record<string, unknown>)
          if (line) void writeStdout(line)
          return
        }
        if (options.output !== 'text' || options.quiet) return
        if (item.type === 'event') {
          const line = progressLineForEvent(item.event)
          if (line) writeStderr(`${line}\n`)
        } else if (item.type === 'approval_decision') {
          writeStderr(`  ${item.decision === 'denied' ? '⊘ refused' : '✓ allowed'} ${item.tool}: ${item.reason}\n`)
        } else if (item.type === 'question_answered') {
          writeStderr(`  ? ${item.kind} question ${item.answer}\n`)
        } else if (item.type === 'run_started') {
          writeStderr(`Run ${item.runId} in ${item.workspacePath}\n`)
        }
      }

      const result = await runHeadlessTask({
        workspacePath: inputs.workspacePath,
        prompt: inputs.prompt,
        mode: options.mode,
        provider: inputs.provider,
        model: inputs.model,
        approval: options.approval,
        onQuestion: options.onQuestion,
        doneWhen: options.doneWhen,
        maxSteps: options.maxSteps,
        maxCostUsd: options.maxCostUsd,
        timeoutMs: options.timeoutSec ? Math.round(options.timeoutSec * 1000) : undefined,
        worktree: options.worktree,
        signal: interrupt.signal,
        onItem
      })

      await shutdown()
      const out = finalOutput(options.output, result)
      // Whatever the format, the file gets the JSON result: a CI artifact, and
      // the fallback where a console never sees a GUI-built exe's stdout.
      writeOutputFile(options.outputFile, `${JSON.stringify(result, null, 2)}\n`)
      if (options.output === 'text' && !options.quiet) writeStderr(textSummaryLine(result))
      logger.info('Headless run finished', {
        scope: 'headless',
        correlationId: result.runId,
        status: result.status,
        exitCode: result.exitCode
      })
      return exitWith(result.exitCode, out)
    })
    .catch(async (err: unknown) => {
      logger.error('Headless run crashed', { scope: 'headless', err })
      writeStderr(`Headless run failed: ${err instanceof Error ? err.message : String(err)}\n`)
      await shutdown()
      return exitWith(1)
    })
}
