import { wrapUntrustedContent } from '../untrustedContent'

/**
 * Fence terminal output that a command fetched from the network.
 *
 * `curl https://…` prints whatever a remote server chose to send, straight into
 * the model's context — the same prompt-injection surface as a browsed page,
 * which is already fenced. Ordinary command output (a build, a test run, `ls`)
 * is left alone on purpose: fencing every result would change prompt bytes for
 * normal coding and spend tokens on an envelope that buys nothing there.
 *
 * Only the output is fenced. The frame's own headers (`session_id:`, `cwd:`,
 * `shell:`) and its trailing `exit_code:` line plus any harness hints after it
 * stay outside, so the model still reads them as the harness's own words and
 * `parseTerminalOutput` (which strips the fence) sees the frame it expects.
 */

/** Commands whose stdout is a remote server's response body. `git clone` is not: it prints progress. */
const FETCH_COMMANDS = [
  'curl',
  'curlie',
  'wget',
  'wget2',
  'aria2c',
  'xh',
  'http',
  'https',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'start-bitstransfer'
]

/**
 * Where a command name can start: line start, after a shell separator or
 * opening quote/paren/substitution, or after a `-c` / `-Command` switch.
 * Then any wrapper words (`sudo`, `env`, `xargs` …) and `VAR=value`
 * assignments, then an optional directory prefix.
 */
const COMMAND_START = String.raw`(?:^|[\n;|&({\x60"']|\$\(|\s-(?:c|command)\s+)\s*`
const WRAPPERS = String.raw`(?:(?:sudo|doas|time|nohup|env|exec|command|builtin|xargs|watch|call)\s+(?:-\S+\s+)*|[A-Za-z_]\w*=\S*\s+)*`
const DIR_PREFIX = String.raw`(?:[^\s"'\x60;|&()]*[\\/])?`
const COMMAND_END = String.raw`(?:\.exe)?(?=[\s"'\x60;|&)]|$)`

const FETCH_RE = new RegExp(
  `${COMMAND_START}${WRAPPERS}${DIR_PREFIX}(?:${FETCH_COMMANDS.join('|')})${COMMAND_END}`,
  'i'
)
/** `gh api` returns a remote JSON body (issue text, PR comments …). */
const GH_API_RE = new RegExp(`${COMMAND_START}${WRAPPERS}${DIR_PREFIX}gh${COMMAND_END}\\s+api\\b`, 'i')

/** True when the command fetches remote content and prints it. */
export function commandFetchesRemoteContent(command: string): boolean {
  if (!command.trim()) return false
  return FETCH_RE.test(command) || GH_API_RE.test(command)
}

/** Frame headers the terminal tool writes ahead of the output. */
const FRAME_HEADER_START = /^(?:session_id|cwd):/
const EXIT_LINE_RE = /^exit_code:\s*-?\d+\s*(?:\n|$)/

const ORIGIN_MAX_CHARS = 200

/**
 * Wrap the output region of a terminal frame in the untrusted-content envelope
 * when `command` fetched remote content; return `content` unchanged otherwise.
 */
export function fenceRemoteTerminalOutput(content: string, command: string): string {
  if (!commandFetchesRemoteContent(command)) return content

  let head = ''
  let rest = content
  if (FRAME_HEADER_START.test(content)) {
    const blank = content.indexOf('\n\n')
    if (blank >= 0) {
      head = content.slice(0, blank + 2)
      rest = content.slice(blank + 2)
    }
  }

  // The frame's own `exit_code:` line comes after all output, so the last one
  // is it; hints appended after it are the harness's, not the server's.
  let tail = ''
  let body = rest
  const scan = `\n${rest}`
  const at = scan.lastIndexOf('\nexit_code:')
  if (at >= 0 && EXIT_LINE_RE.test(scan.slice(at + 1))) {
    tail = scan.slice(at)
    body = scan.slice(1, at)
  }
  if (!body.trim()) return content

  const origin = command.replace(/\s+/g, ' ').trim().slice(0, ORIGIN_MAX_CHARS)
  return `${head}${wrapUntrustedContent(body, { source: 'terminal', origin, kind: 'remote_fetch' })}${tail}`
}
