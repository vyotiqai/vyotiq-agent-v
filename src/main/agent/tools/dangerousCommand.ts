import path from 'path'

/**
 * Commands that can destroy work beyond what a checkpoint or rewind brings
 * back: a recursive delete that reaches outside the workspace (or takes the
 * whole workspace, or its `.git`), a push that rewrites or deletes remote
 * history, `git reset --hard` / `git clean -f`, formatting a disk, and piping
 * a download straight into a shell.
 *
 * The approval gate asks before any of these whatever the approval mode,
 * allowlist or autonomy setting says. It is a static reading of the command
 * text, so it errs toward asking: a path it cannot resolve before the command
 * runs (`$DIR`, `%TEMP%`) counts as outside the workspace.
 */
export type DangerousCommand = {
  kind: 'recursive-delete' | 'remote-rewrite' | 'discard-work' | 'disk-format' | 'pipe-to-shell'
  /** Plain words for the approval card: what the command would do. */
  reason: string
}

export type CommandContext = {
  /** Workspace root, absolute. */
  workspaceRoot: string
  /** Where the command starts, absolute (the terminal's working_directory). */
  cwd: string
  homeDir: string
  platform: NodeJS.Platform
  /**
   * How the shell reads the line: `posix` (sh, bash, Git Bash) escapes with a
   * backslash and substitutes with backticks; `windows` (PowerShell, cmd)
   * keeps backslashes as path separators and escapes with the backtick.
   */
  syntax: 'posix' | 'windows'
}

type Segment = {
  words: string[]
  /** True when this segment's stdout is piped into the next one. */
  pipesToNext: boolean
}

type Syntax = CommandContext['syntax']

const SEPARATOR_CHARS = new Set([';', '&', '|', '\n', '\r'])

/**
 * Split a command line into simple commands and their words. Quotes group,
 * `;` `&&` `||` `&` `|` and newlines separate. `$(…)`, `<(…)` and (posix)
 * backticks are kept inside their word — their contents are read separately
 * by {@link substitutions}.
 */
function splitSegments(command: string, syntax: Syntax): Segment[] {
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  let parenDepth = 0
  let inBacktick = false

  const endWord = (): void => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = (pipesToNext: boolean): void => {
    endWord()
    if (words.length > 0) segments.push({ words, pipesToNext })
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = command[i + 1]
    if (quote) {
      if (ch === quote) quote = null
      else if (syntax === 'posix' && ch === '\\' && quote === '"' && (next === '"' || next === '\\')) {
        word += next
        i++
      } else if (syntax === 'windows' && ch === '`' && quote === '"' && next !== undefined) {
        word += next
        i++
      } else word += ch
      continue
    }
    if (parenDepth > 0 || inBacktick) {
      word += ch
      if (inBacktick && ch === '`') inBacktick = false
      else if (!inBacktick && ch === '(') parenDepth++
      else if (!inBacktick && ch === ')') parenDepth--
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
      continue
    }
    if (syntax === 'posix' && ch === '\\' && next !== undefined) {
      word += next
      inWord = true
      i++
      continue
    }
    if (ch === '$' && next === '(') {
      parenDepth = 1
      word += '$('
      inWord = true
      i++
      continue
    }
    if (ch === '<' && next === '(') {
      parenDepth = 1
      word += '<('
      inWord = true
      i++
      continue
    }
    if (ch === '`') {
      inWord = true
      if (syntax === 'windows') {
        // PowerShell's escape character: the next one is literal.
        if (next !== undefined) word += next
        i++
      } else {
        inBacktick = true
        word += ch
      }
      continue
    }
    if (ch === '(' || ch === ')') {
      // PowerShell's `iex (iwr …)` and a subshell's `( … )`: a word break.
      endWord()
      continue
    }
    if (SEPARATOR_CHARS.has(ch)) {
      const pipe = ch === '|' && next !== '|'
      if ((ch === '&' || ch === '|') && next === ch) i++
      endSegment(pipe)
      continue
    }
    if (/\s/.test(ch)) {
      endWord()
      continue
    }
    word += ch
    inWord = true
  }
  endSegment(false)
  return segments
}

/** The bodies of `$(…)`, `<(…)` and backtick substitutions inside one word. */
function substitutions(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    const open = text[i] === '$' || text[i] === '<' ? text[i + 1] === '(' : false
    if (open) {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')') depth--
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j))
      i = j - 1
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end < 0) break
      out.push(text.slice(i + 1, end))
      i = end
    }
  }
  return out
}

/** Lower-cased program name without directory or Windows extension. */
function programName(word: string): string {
  const base = word.replace(/^.*[\\/]/, '').toLowerCase()
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Wrappers that run the command after them unchanged. */
const PASSTHROUGH = new Set(['sudo', 'doas', 'nohup', 'time', 'command', 'exec', 'nice', 'env', 'xargs', 'npx', 'bunx', '&'])
/** `pnpm dlx rimraf …`, `npm exec -- rimraf …`: a package manager running a package's binary. */
const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const PACKAGE_RUN_VERBS = new Set(['dlx', 'exec', 'x'])

type Unwrapped = {
  words: string[]
  /** Run by `xargs`, so more arguments arrive from its input. */
  argsFromInput: boolean
}

/** The command a segment actually runs, past env assignments and wrappers. */
function unwrap(words: readonly string[]): Unwrapped {
  let i = 0
  let argsFromInput = false
  for (;;) {
    while (i < words.length && ENV_ASSIGNMENT.test(words[i]!)) i++
    const w = words[i]
    if (w === undefined) return { words: [], argsFromInput }
    const prog = programName(w)
    if (PACKAGE_RUNNERS.has(prog) && PACKAGE_RUN_VERBS.has((words[i + 1] ?? '').toLowerCase())) {
      i += 2
    } else if (PASSTHROUGH.has(prog)) {
      if (prog === 'xargs') argsFromInput = true
      i++
    } else {
      return { words: words.slice(i), argsFromInput }
    }
    // `sudo -u root rm …`, `env -i rm …`, `nice -n 5 rm …`, `npx -y rimraf`: skip the wrapper's own flags.
    while (i < words.length && words[i]!.startsWith('-')) {
      const flag = words[i]!
      i++
      if ((prog === 'sudo' && /^-[ugCDhpRrTt]$/.test(flag)) || (prog === 'nice' && flag === '-n')) i++
    }
  }
}

function effectiveWords(words: readonly string[]): string[] {
  return unwrap(words).words
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash'])
const POWERSHELLS = new Set(['powershell', 'pwsh'])
const INTERPRETERS = new Set([
  ...SHELLS,
  ...POWERSHELLS,
  'cmd',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'node',
  'iex',
  'invoke-expression'
])
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod'])

/** A script string handed to a shell: `bash -c "…"`, `powershell -Command …`, `cmd /c …`. */
function inlineScript(words: readonly string[]): { script: string; syntax: Syntax } | null {
  const prog = programName(words[0] ?? '')
  const rest = (i: number): string => words.slice(i + 1).join(' ')
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    const lw = w.toLowerCase()
    if (SHELLS.has(prog) && /^-[a-z]*c[a-z]*$/.test(w)) return rest(i) ? { script: rest(i), syntax: 'posix' } : null
    if (POWERSHELLS.has(prog) && /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(lw)) {
      return rest(i) ? { script: rest(i), syntax: 'windows' } : null
    }
    if (prog === 'cmd' && (lw === '/c' || lw === '/k')) return rest(i) ? { script: rest(i), syntax: 'windows' } : null
  }
  return null
}

function mentionsDownloader(text: string, syntax: Syntax): boolean {
  return splitSegments(text, syntax).some((segment) => {
    const words = effectiveWords(segment.words)
    return words.length > 0 && DOWNLOADERS.has(programName(words[0]!))
  })
}

// ---- paths -----------------------------------------------------------------

type PathLib = typeof path.posix

function pathLib(platform: NodeJS.Platform): PathLib {
  return platform === 'win32' ? path.win32 : path.posix
}

const HOME_VARS = /^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%)(?=$|[\\/])/i
/** A variable, a substitution or a backtick: only known once the command runs. */
const UNRESOLVED_VAR = /\$[A-Za-z_{(]|%[A-Za-z_][A-Za-z0-9_]*%|`/
const GLOB_CHARS = /[*?[\]{}]/

/**
 * Where a path argument points, or null when it cannot be known before the
 * command runs. A glob resolves to the directory it expands in.
 */
function resolveTarget(target: string, cwd: string | null, ctx: CommandContext): string | null {
  const lib = pathLib(ctx.platform)
  let t = target
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = ctx.homeDir + t.slice(1)
  t = t.replace(HOME_VARS, ctx.homeDir)
  if (UNRESOLVED_VAR.test(t)) return null
  if (ctx.platform === 'win32') {
    // Git Bash spells C:\ as /c/.
    const msys = /^\/([A-Za-z])(?=\/|$)/.exec(t)
    if (msys) t = `${msys[1]}:\\${t.slice(2)}`
  }
  const glob = t.search(GLOB_CHARS)
  if (glob >= 0) {
    const head = t.slice(0, glob)
    const cut = Math.max(head.lastIndexOf('/'), ctx.platform === 'win32' ? head.lastIndexOf('\\') : -1)
    t = cut >= 0 ? head.slice(0, cut + 1) || '/' : '.'
  }
  if (lib.isAbsolute(t)) return lib.resolve(t)
  return cwd === null ? null : lib.resolve(cwd, t)
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const lib = pathLib(platform)
  const rel = lib.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !lib.isAbsolute(rel)
}

/**
 * Why deleting `target` recursively is out of bounds, or null when it stays
 * inside the workspace. `rootIsSearch` is for `find`: its root is where the
 * search starts, not what goes, so the workspace root itself is fine there.
 */
function deleteTargetProblem(
  target: string,
  cwd: string | null,
  ctx: CommandContext,
  rootIsSearch = false
): string | null {
  const resolved = resolveTarget(target, cwd, ctx)
  if (resolved === null) return `${target}, a path that is only known when the command runs`
  const root = pathLib(ctx.platform).resolve(ctx.workspaceRoot)
  if (samePath(resolved, root, ctx.platform)) return rootIsSearch ? null : 'the whole workspace'
  if (!isInside(root, resolved, ctx.platform)) return `${target}, outside the workspace`
  const gitDir = pathLib(ctx.platform).join(root, '.git')
  if (samePath(resolved, gitDir, ctx.platform) || isInside(gitDir, resolved, ctx.platform)) {
    return "the repository's git history"
  }
  return null
}

// ---- rules -----------------------------------------------------------------

const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'ri', 'remove-item', 'rimraf'])
/** PowerShell parameters whose value is a pattern or a setting, not a path to delete. */
const PS_VALUED_PARAMS = /^-(filter|include|exclude|erroraction|ea|warningaction|wa|credential|stream)$/i

/**
 * `input` is how else the command gets paths to delete: `args` when `xargs`
 * appends them, `pipe` when a pipeline feeds it (PowerShell binds piped items
 * to Remove-Item's -Path).
 */
function recursiveDelete(
  words: readonly string[],
  cwd: string | null,
  ctx: CommandContext,
  input: 'args' | 'pipe' | null
): DangerousCommand | null {
  const prog = programName(words[0]!)
  // rimraf has no other mode.
  let recursive = prog === 'rimraf'
  const targets: string[] = []
  let endOfFlags = false
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    const lw = w.toLowerCase()
    if (!endOfFlags && w === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && w.startsWith('--')) {
      if (lw === '--recursive') recursive = true
      continue
    }
    if (!endOfFlags && /^\/[a-z]$/i.test(w) && prog !== 'rm') {
      // cmd: `rd /s /q`, `del /s /q`
      if (lw === '/s') recursive = true
      continue
    }
    if (!endOfFlags && w.startsWith('-') && w.length > 1) {
      if (PS_VALUED_PARAMS.test(w)) {
        i++
        continue
      }
      // PowerShell -Recurse and its abbreviations (-r, -rec, -recurse:$true).
      if (/^-r(e(c(u(r(s(e)?)?)?)?)?)?(:\$true)?$/i.test(w)) recursive = true
      // POSIX clusters: -rf, -Rf, -fr, -r.
      else if (/^-[a-zA-Z]+$/.test(w) && /[rR]/.test(w)) recursive = true
      else if (/^-(path|literalpath|lp)$/i.test(w) && words[i + 1] !== undefined) {
        targets.push(words[i + 1]!)
        i++
      }
      continue
    }
    targets.push(w)
  }
  if (!recursive) return null
  if (input === 'args' || (input === 'pipe' && targets.length === 0)) {
    return { kind: 'recursive-delete', reason: 'Deletes paths it reads from its input, recursively' }
  }
  for (const target of targets) {
    for (const part of target.split(',')) {
      const problem = part ? deleteTargetProblem(part, cwd, ctx) : null
      if (problem) return { kind: 'recursive-delete', reason: `Deletes ${problem}, recursively` }
    }
  }
  return null
}

function findDelete(words: readonly string[], cwd: string | null, ctx: CommandContext): DangerousCommand | null {
  const deletes = words.includes('-delete') || words.some((w, i) => w === '-exec' && programName(words[i + 1] ?? '') === 'rm')
  if (!deletes) return null
  const roots: string[] = []
  for (let i = 1; i < words.length && !words[i]!.startsWith('-') && words[i] !== '(' && words[i] !== '!'; i++) {
    roots.push(words[i]!)
  }
  for (const root of roots.length > 0 ? roots : ['.']) {
    const problem = deleteTargetProblem(root, cwd, ctx, true)
    if (problem) return { kind: 'recursive-delete', reason: `Deletes files under ${problem}` }
  }
  return null
}

/** Git's global options that take a separate value: `git -C dir push`. */
const GIT_VALUED_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

function gitSubcommand(words: readonly string[]): { sub: string; args: string[] } | null {
  let i = 1
  while (i < words.length && words[i]!.startsWith('-')) {
    if (GIT_VALUED_GLOBALS.has(words[i]!)) i++
    i++
  }
  const sub = words[i]
  return sub ? { sub: sub.toLowerCase(), args: words.slice(i + 1) } : null
}

function gitRule(words: readonly string[]): DangerousCommand | null {
  const parsed = gitSubcommand(words)
  if (!parsed) return null
  const { sub, args } = parsed
  if (sub === 'push') {
    // A dry run sends nothing.
    if (args.some((a) => a === '--dry-run' || (/^-[a-zA-Z]+$/.test(a) && a.includes('n')))) return null
    for (const a of args) {
      if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || (/^-[a-zA-Z]+$/.test(a) && a.includes('f'))) {
        return { kind: 'remote-rewrite', reason: 'Force-pushes, which rewrites history on the remote' }
      }
      if (a === '--mirror') return { kind: 'remote-rewrite', reason: 'Mirrors to the remote, which can delete and rewrite every branch there' }
      if (a === '--delete' || (/^-[a-zA-Z]+$/.test(a) && a.includes('d'))) {
        return { kind: 'remote-rewrite', reason: 'Deletes a branch or tag on the remote' }
      }
      if (/^\+[^+]/.test(a)) return { kind: 'remote-rewrite', reason: 'Force-pushes a refspec, which rewrites history on the remote' }
      if (/^:[^:]/.test(a)) return { kind: 'remote-rewrite', reason: 'Deletes a branch or tag on the remote' }
    }
    return null
  }
  if (sub === 'reset' && args.includes('--hard')) {
    return { kind: 'discard-work', reason: 'Discards every uncommitted change in the working tree' }
  }
  if (sub === 'clean' && args.some((a) => a === '--force' || (/^-[a-zA-Z]+$/.test(a) && a.includes('f')))) {
    return { kind: 'discard-work', reason: 'Deletes untracked files, which git cannot bring back' }
  }
  return null
}

const DISK_PROGRAMS = new Set(['diskpart', 'fdisk', 'sfdisk', 'gdisk', 'parted', 'wipefs', 'format-volume', 'clear-disk', 'initialize-disk'])

function diskRule(words: readonly string[]): DangerousCommand | null {
  const prog = programName(words[0]!)
  if (prog === 'mkfs' || prog.startsWith('mkfs.') || DISK_PROGRAMS.has(prog)) {
    return { kind: 'disk-format', reason: 'Partitions, formats or wipes a disk' }
  }
  if (prog === 'format' && words.slice(1).some((w) => /^[A-Za-z]:\\?$/.test(w))) {
    return { kind: 'disk-format', reason: 'Formats a drive' }
  }
  if (prog === 'dd' && words.some((w) => /^of=(\/dev\/|\\\\\.\\)/i.test(w))) {
    return { kind: 'disk-format', reason: 'Writes raw data over a disk device' }
  }
  return null
}

/** `cd dir`, `Set-Location dir`, `pushd dir`: where the next segments run, or undefined when this is not one. */
function cdTarget(words: readonly string[], cwd: string | null, ctx: CommandContext): string | null | undefined {
  const prog = programName(words[0]!)
  if (!['cd', 'chdir', 'pushd', 'set-location', 'sl'].includes(prog)) return undefined
  const arg = words.slice(1).find((w) => !w.startsWith('-') && !/^\/d$/i.test(w))
  if (arg === undefined) return ctx.homeDir
  return resolveTarget(arg, cwd, ctx)
}

const PIPE_TO_SHELL: DangerousCommand = {
  kind: 'pipe-to-shell',
  reason: 'Runs a script downloaded from the internet without saving it first'
}

function checkText(
  command: string,
  cwd: string | null,
  ctx: CommandContext,
  syntax: Syntax,
  depth: number
): DangerousCommand | null {
  if (depth > 4) return null
  const segments = splitSegments(command, syntax)
  let here = cwd
  // A download earlier in the pipeline this segment reads from:
  // `curl … | tee i.sh | sh` still runs what came off the network.
  let downloadUpstream = false
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]!
    const piped = s > 0 && segments[s - 1]!.pipesToNext
    const upstream: boolean = downloadUpstream
    const { words, argsFromInput } = unwrap(segment.words)
    downloadUpstream = segment.pipesToNext && (upstream || (words.length > 0 && DOWNLOADERS.has(programName(words[0]!))))
    if (words.length === 0) continue
    const prog = programName(words[0]!)

    for (const word of segment.words) {
      for (const inner of substitutions(word)) {
        const found = checkText(inner, here, ctx, syntax, depth + 1)
        if (found) return found
      }
    }

    if (upstream && INTERPRETERS.has(prog)) return PIPE_TO_SHELL
    if (INTERPRETERS.has(prog) && segment.words.some((w) => substitutions(w).some((t) => mentionsDownloader(t, syntax)))) {
      return PIPE_TO_SHELL
    }
    if ((prog === 'iex' || prog === 'invoke-expression') && mentionsDownloader(words.slice(1).join(' '), syntax)) {
      return PIPE_TO_SHELL
    }

    const inline = inlineScript(words)
    if (inline) {
      const found = checkText(inline.script, here, ctx, inline.syntax, depth + 1)
      if (found) return found
    }

    const input = argsFromInput ? 'args' : piped ? 'pipe' : null
    const found =
      (DELETE_PROGRAMS.has(prog) ? recursiveDelete(words, here, ctx, input) : null) ??
      (prog === 'find' ? findDelete(words, here, ctx) : null) ??
      (prog === 'git' ? gitRule(words) : null) ??
      diskRule(words)
    if (found) return found

    const moved = cdTarget(words, here, ctx)
    if (moved !== undefined) here = moved
  }
  return null
}

/** Why this shell command needs the user's OK whatever the approval settings say, or null. */
export function dangerousCommand(command: string, ctx: CommandContext): DangerousCommand | null {
  if (!command.trim()) return null
  return checkText(command, ctx.cwd, ctx, ctx.syntax, 0)
}

/**
 * Every simple command a line runs, as the words it starts with past env
 * assignments and wrappers (`sudo`, `env`, `npx`…): each side of `&&` `;` `|`,
 * the bodies of `$(…)` and backticks, and a script handed to `bash -c` or
 * `powershell -Command`. What a deny or ask permission rule on a command
 * prefix reads, so `a && b` cannot hide `b` behind `a`.
 */
export function simpleCommands(command: string, syntax: Syntax): string[][] {
  const out: string[][] = []
  const visit = (text: string, how: Syntax, depth: number): void => {
    if (depth > 4) return
    for (const segment of splitSegments(text, how)) {
      for (const word of segment.words) {
        for (const inner of substitutions(word)) visit(inner, how, depth + 1)
      }
      const { words } = unwrap(segment.words)
      if (words.length === 0) continue
      out.push(words)
      const inline = inlineScript(words)
      if (inline) visit(inline.script, inline.syntax, depth + 1)
    }
  }
  visit(command, syntax, 0)
  return out
}

/** Lower-cased program name without directory or Windows extension (`C:\x\Git.EXE` → `git`). */
export function commandProgramName(word: string): string {
  return programName(word)
}
