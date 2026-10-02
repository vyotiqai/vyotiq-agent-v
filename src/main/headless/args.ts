/**
 * `Vyotiq --headless …`: the command line of a scripted, windowless run.
 *
 * Pure on purpose — no Electron, no fs — so the whole grammar is unit-tested
 * and `index.ts` can ask "is this a headless launch?" before it creates a
 * window or takes the single-instance lock.
 *
 * Only the tokens AFTER `--headless` are ours. Everything before it belongs to
 * whoever launched us: the dev launcher's app path (`electron . --headless`),
 * Chromium/Electron switches (`--inspect`, `--enable-logging`). After it, an
 * unknown flag is a usage error rather than something silently ignored — a
 * typo in `--max-cost` must not become an unbounded run.
 */

export const HEADLESS_FLAG = '--headless'

export const APPROVAL_POLICIES = ['deny', 'allow-safe', 'allow-all'] as const
export type HeadlessApprovalPolicy = (typeof APPROVAL_POLICIES)[number]

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const
export type HeadlessOutputFormat = (typeof OUTPUT_FORMATS)[number]

export const QUESTION_POLICIES = ['answer', 'fail'] as const
export type HeadlessQuestionPolicy = (typeof QUESTION_POLICIES)[number]

export const HEADLESS_MODES = ['agent', 'ask'] as const
export type HeadlessMode = (typeof HEADLESS_MODES)[number]

export type HeadlessPromptSource =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin' }
  /** No prompt flag: read stdin when it is piped, otherwise a usage error. */
  | { kind: 'auto' }

export type HeadlessOptions = {
  /** Workspace folder; `undefined` means the process cwd. */
  cwd?: string
  prompt: HeadlessPromptSource
  mode: HeadlessMode
  /** Raw `--model` value; split into provider/model by {@link splitModelArg}. */
  model?: string
  approval: HeadlessApprovalPolicy
  onQuestion: HeadlessQuestionPolicy
  doneWhen: string[]
  maxSteps?: number
  maxCostUsd?: number
  timeoutSec?: number
  output: HeadlessOutputFormat
  outputFile?: string
  worktree: boolean
  quiet: boolean
}

export type ParseHeadlessResult =
  | { ok: true; options: HeadlessOptions }
  | { ok: true; help: true }
  | { ok: false; error: string }

export const HEADLESS_USAGE = `Usage: Vyotiq --headless [options]

Runs one task with no window and exits. Uses your saved settings and keys.

Prompt (one of; default: stdin when piped):
  -p, --prompt <text>        The instruction. "-" reads stdin.
      --prompt-file <path>   Read the instruction from a file.

Run:
      --cwd <dir>            Workspace folder (default: current directory).
      --mode agent|ask       agent may edit; ask is read-only (default: agent).
      --model [provider/]id  Model for this run, e.g. anthropic/claude-sonnet-4-5.
      --done-when <text>     A condition the run is judged against (repeatable).
      --worktree             Run in a new git worktree branched from HEAD.

Approvals (nobody is there to click):
      --approval deny|allow-safe|allow-all   (default: deny)
            deny        refuse every call that would ask
            allow-safe  allow reads and file edits; refuse shell, delete, git, MCP
            allow-all   allow everything that would ask
          Permission-rule denies, protected paths and the dangerous-command
          guard always apply: a call only a person may OK is refused.
      --on-question answer|fail   ask_question: answer "no human" or stop (default: answer)

Limits:
      --max-steps <n>        Stop after n model steps.
      --max-cost <usd>       Stop once the run has spent this much.
      --timeout <seconds>    Stop after this long (exit 124).

Output:
      --output text|json|stream-json   (default: text)
      --output-file <path>   Also write the JSON result to a file.
  -q, --quiet                text: no progress on stderr.
  -h, --help                 Show this help.

Electron switches written --switch=value, such as --user-data-dir=<dir> for a
separate profile, pass through wherever they appear.

Exit codes: 0 done, 1 failed or not met, 2 usage error,
            3 blocked on a denied approval or a question, 124 timeout, 130 interrupted.`

/** True when this process was launched as a headless run. */
export function isHeadlessArgv(argv: readonly string[]): boolean {
  return argv.includes(HEADLESS_FLAG)
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value)
}

function positiveNumber(raw: string, flag: string, integer: boolean): number | string {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (!trimmed || !Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    return `${flag} needs a positive ${integer ? 'whole number' : 'number'}, got "${raw}"`
  }
  return n
}

/** Flags that take a value, by every spelling. */
const VALUE_FLAGS = new Set([
  '--cwd',
  '--prompt',
  '-p',
  '--prompt-file',
  '--mode',
  '--model',
  '--approval',
  '--on-question',
  '--done-when',
  '--max-steps',
  '--max-cost',
  '--timeout',
  '--output',
  '--output-file'
])

const BOOLEAN_FLAGS = new Set(['--worktree', '--quiet', '-q', '--help', '-h'])

/**
 * Electron/Chromium switches people put anywhere on the line. Chromium reads
 * them from the whole command line wherever they sit, so here they are only
 * stepped over — `--user-data-dir=<dir>` (a separate profile) is the one that
 * matters. Written `--switch=value`; a bare value after them is not ours to take.
 */
const ELECTRON_SWITCHES = new Set([
  '--user-data-dir',
  '--inspect',
  '--inspect-brk',
  '--remote-debugging-port',
  '--enable-logging',
  '--v',
  '--lang',
  '--disable-gpu',
  '--no-sandbox',
  '--proxy-server',
  '--ignore-certificate-errors-spki-list'
])

export function parseHeadlessArgs(argv: readonly string[]): ParseHeadlessResult {
  const at = argv.indexOf(HEADLESS_FLAG)
  if (at < 0) return { ok: false, error: `${HEADLESS_FLAG} is missing` }
  const tokens = argv.slice(at + 1)

  const options: HeadlessOptions = {
    prompt: { kind: 'auto' },
    mode: 'agent',
    approval: 'deny',
    onQuestion: 'answer',
    doneWhen: [],
    output: 'text',
    worktree: false,
    quiet: false
  }
  let promptGiven: string | null = null
  const setPrompt = (flag: string, source: HeadlessPromptSource): string | null => {
    if (promptGiven) return `Give the prompt once: ${promptGiven} and ${flag} were both set`
    promptGiven = flag
    options.prompt = source
    return null
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    // `--flag=value` and `--flag value` are the same thing.
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = eq > 0 ? token.slice(0, eq) : token
    let inline: string | undefined = eq > 0 ? token.slice(eq + 1) : undefined

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) return { ok: false, error: `${flag} takes no value` }
      switch (flag) {
        case '--help':
        case '-h':
          return { ok: true, help: true }
        case '--worktree':
          options.worktree = true
          break
        default:
          options.quiet = true
      }
      continue
    }
    if (ELECTRON_SWITCHES.has(flag)) continue
    if (!VALUE_FLAGS.has(flag)) {
      return {
        ok: false,
        error: flag.startsWith('-')
          ? `Unknown option ${flag}`
          : `Unexpected argument "${token}" — quote the prompt and pass it with --prompt`
      }
    }
    if (inline === undefined) {
      const next = tokens[i + 1]
      // A value may itself start with "-" only for --prompt ("-" is stdin).
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        return { ok: false, error: `${flag} needs a value` }
      }
      inline = next
      i++
    }
    const value = inline

    let problem: string | null = null
    switch (flag) {
      case '--cwd':
        if (!value.trim()) problem = '--cwd needs a folder'
        else options.cwd = value
        break
      case '--prompt':
      case '-p':
        problem =
          value === '-'
            ? setPrompt(flag, { kind: 'stdin' })
            : value.trim()
              ? setPrompt(flag, { kind: 'text', text: value })
              : `${flag} is empty`
        break
      case '--prompt-file':
        problem = value.trim() ? setPrompt(flag, { kind: 'file', path: value }) : '--prompt-file needs a path'
        break
      case '--mode': {
        // `plan` folded into agent, as everywhere else in the app.
        const mode = value === 'plan' ? 'agent' : value
        if (oneOf(mode, HEADLESS_MODES)) options.mode = mode
        else problem = `--mode must be one of ${HEADLESS_MODES.join(', ')}`
        break
      }
      case '--model':
        if (!value.trim() || value.endsWith('/')) problem = '--model needs a model id'
        else options.model = value.trim()
        break
      case '--approval':
        if (oneOf(value, APPROVAL_POLICIES)) options.approval = value
        else problem = `--approval must be one of ${APPROVAL_POLICIES.join(', ')}`
        break
      case '--on-question':
        if (oneOf(value, QUESTION_POLICIES)) options.onQuestion = value
        else problem = `--on-question must be one of ${QUESTION_POLICIES.join(', ')}`
        break
      case '--done-when':
        if (value.trim()) options.doneWhen.push(value.trim())
        else problem = '--done-when is empty'
        break
      case '--max-steps': {
        const n = positiveNumber(value, flag, true)
        if (typeof n === 'string') problem = n
        else options.maxSteps = n
        break
      }
      case '--max-cost': {
        const n = positiveNumber(value, flag, false)
        if (typeof n === 'string') problem = n
        else options.maxCostUsd = n
        break
      }
      case '--timeout': {
        const n = positiveNumber(value, flag, false)
        if (typeof n === 'string') problem = n
        else options.timeoutSec = n
        break
      }
      case '--output':
        if (oneOf(value, OUTPUT_FORMATS)) options.output = value
        else problem = `--output must be one of ${OUTPUT_FORMATS.join(', ')}`
        break
      case '--output-file':
        if (value.trim()) options.outputFile = value
        else problem = '--output-file needs a path'
        break
    }
    if (problem) return { ok: false, error: problem }
  }
  return { ok: true, options }
}

/**
 * `anthropic/claude-x` → provider + model when the part before the first "/"
 * is a provider id the app knows; anything else is a model id on the
 * configured provider (OpenRouter-style ids carry slashes of their own).
 */
export function splitModelArg(
  value: string,
  isProviderId: (id: string) => boolean
): { provider?: string; model: string } {
  const slash = value.indexOf('/')
  if (slash > 0) {
    const provider = value.slice(0, slash)
    const model = value.slice(slash + 1)
    if (model && isProviderId(provider)) return { provider, model }
  }
  return { model: value }
}
