import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { PermissionRuleSchema, type PermissionRule, type PermissionRuleEffect } from '../../shared/ipc'
import {
  DEFAULT_ASK_PATHS,
  DEFAULT_ASK_PATH_EXCEPTIONS,
  WORKSPACE_PERMISSIONS_FILE,
  permissionRuleLabel
} from '../../shared/permissionRules'
import { commandMatchesAllow } from '../../shared/utils/commandAllow'
import { userDataRoot } from '../storage/paths'
import { realpathIfExists } from '../workspace/safePath'
import { patchTouchedPaths } from './tools/applyPatch'
import { commandProgramName, simpleCommands } from './tools/dangerousCommand'
import type { SkillToolAllow } from './skills/allowedTools'

/**
 * Permission rules: deny, ask and allow, by tool, terminal command prefix or
 * path, checked by the approval gate (toolApproval.ts) before the approval
 * mode, the allowlists and autonomy get a say.
 *
 * Three tiers, first answer wins:
 *
 *   1. Protected paths. The app's data folder (keys in secrets.json, settings,
 *      Chromium's Local State and Cookies) and writes to the workspace's own
 *      `.vyotiq/permissions.json` are denied. No rule lets them through.
 *   2. Configured rules — Settings, plus the workspace's permissions file —
 *      with deny over ask over allow.
 *   3. Built-in asks for secrets (`.env`, keys, `~/.ssh`), which a path allow
 *      rule of your own that covers the file lifts, and for changes to your
 *      personal skills (`~/.vyotiq/skills`), which nothing lifts.
 *   4. An active skill's `allowed-tools` (skills/allowedTools.ts): an allow,
 *      consulted after your own allow rules.
 *
 * Paths are read from the call's arguments (and a patch's headers), resolved
 * against the workspace and, where they exist, through symlinks. A terminal
 * command is read statically, like the command guard: the words that look like
 * paths count, and the app's data folder anywhere in the text is denied.
 */

export type PermissionSource = 'settings' | 'workspace' | 'built-in' | 'skill'
export type SourcedPermissionRule = PermissionRule & { source: Exclude<PermissionSource, 'skill'> }

export type PermissionVerdict = {
  effect: PermissionRuleEffect
  /** Deny: the tool error the model reads. Ask: what the approval card says. */
  reason: string
  /** The rule in words, for the log and a standing grant. */
  rule: string
  source: PermissionSource
  /** source 'skill': the active skill whose `allowed-tools` allowed the call. */
  skill?: string
}

/** One active skill's pre-approvals (skills/allowedTools.ts). */
export type ActiveSkillAllows = { skill: string; allows: readonly SkillToolAllow[] }

export type PermissionPolicyInput = {
  rules: readonly SourcedPermissionRule[]
  /** Where the run's file tools resolve paths (a worktree for an instance). */
  workspaceRoot: string
  /**
   * The task's added folders (extraRoots.ts). A path inside one is matched
   * relative to it as well as absolute, and its own permissions file is
   * protected as the workspace's is.
   */
  extraRoots?: readonly string[]
  /** Electron userData; null outside the app (nothing is protected then). */
  userDataDir: string | null
  homeDir?: string
  platform?: NodeJS.Platform
  /** How the shell reads a command line, as the command guard has it. */
  syntax?: 'posix' | 'windows'
  /** APPDATA and friends, for `%APPDATA%\…` in a command. Defaults to process.env. */
  env?: Partial<Record<'APPDATA' | 'LOCALAPPDATA' | 'XDG_CONFIG_HOME', string>>
  /** Follow symlinks for paths that exist. Default: on when platform is this machine's. */
  resolveSymlinks?: boolean
  /**
   * Personal skills (`~/.vyotiq/skills` by default): their `allowed-tools` run
   * without asking, so a change to them asks. Null: no such folder.
   */
  personalSkillsDir?: string | null
}

export type PermissionPolicy = {
  /**
   * The verdict for one call, or null when no rule speaks to it. `skills` are
   * the run's active skills: their `allowed-tools` answer as allow rules do,
   * after your own allows and never past a deny, an ask or a protected path.
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown> | undefined,
    opts?: { skills?: readonly ActiveSkillAllows[] }
  ): PermissionVerdict | null
  /**
   * True when grep or search must leave this workspace-relative file out: its
   * contents would reach the model past a deny or an ask nobody answered.
   */
  hidesFromSearch(toolName: string, relPath: string): boolean
}

// ── Globs ───────────────────────────────────────────────────────────────────

function escapeRegex(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}

function globBody(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/'
        if (atSegmentStart && glob[i + 2] === '/') {
          // `**/`: any number of folders, none included.
          out += '(?:[^/]*/)*'
          i += 2
          continue
        }
        out += '.*'
        i++
        continue
      }
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    if (ch === '{') {
      const close = glob.indexOf('}', i)
      if (close > i) {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(',')
          .map(globBody)
          .join('|')})`
        i = close
        continue
      }
    }
    out += escapeRegex(ch)
  }
  return out
}

type Anchor = 'rel' | 'abs' | 'absNoDrive'
type CompiledGlob = {
  anchor: Anchor
  re: RegExp
  /** Starts with `**` + `/`: a name at any depth, so it also reads an absolute path. */
  anyDepth: boolean
}

function slashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/**
 * A path pattern as a regex over one form of the path: workspace-relative,
 * absolute, or (a leading `/` on Windows) absolute without its drive.
 */
export function compilePathGlob(
  pattern: string,
  homeDir: string,
  platform: NodeJS.Platform,
  opts?: { rootAnchored?: boolean }
): CompiledGlob {
  let p = slashes(pattern.trim())
  while (p.startsWith('./')) p = p.slice(2)
  let anchor: Anchor = 'rel'
  if (p === '~' || p.startsWith('~/')) {
    p = trimSlash(slashes(homeDir)) + p.slice(1)
    anchor = 'abs'
  } else if (/^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p)) {
    anchor = 'abs'
  } else if (p.startsWith('/')) {
    anchor = platform === 'win32' ? 'absNoDrive' : 'abs'
  }
  // A folder covers what is in it (see `matchesSelfOrAncestor`), so a
  // trailing `/**` says nothing more than the folder.
  while (p.endsWith('/**')) p = p.slice(0, -3)
  p = trimSlash(p)
  if (anchor === 'rel' && !p.includes('/') && p !== '**' && !opts?.rootAnchored) p = `**/${p}`
  const flags = platform === 'win32' || platform === 'darwin' ? 'i' : ''
  return { anchor, re: new RegExp(`^${globBody(p)}$`, flags), anyDepth: anchor === 'rel' && p.startsWith('**/') }
}

/** True when the regex matches the path or any folder it sits in. */
function matchesSelfOrAncestor(re: RegExp, subject: string): boolean {
  let s = subject
  for (;;) {
    if (!s) return false
    if (re.test(s)) return true
    const cut = s.lastIndexOf('/')
    if (cut <= 0) return false
    s = s.slice(0, cut)
  }
}

// ── Paths a call touches ────────────────────────────────────────────────────

type PathKind = 'read' | 'write' | 'delete' | 'mention'

type PathFact = {
  /** Native absolute path. */
  abs: string
  /** Absolute, forward slashes. */
  absKey: string
  /** Workspace-relative, forward slashes; null outside the workspace. */
  rel: string | null
  kind: PathKind
  /** How the call spelled it, for messages. */
  shown: string
}

function stringArg(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

const PATH_KEYS = ['path', 'file', 'filepath', 'filename']

/** Path arguments by tool: what it reads, writes or deletes. */
function toolPaths(name: string, args: Record<string, unknown> | undefined): Array<{ path: string; kind: PathKind }> {
  switch (name) {
    case 'read': {
      const p = stringArg(args, ...PATH_KEYS)
      return p ? [{ path: p, kind: 'read' }] : []
    }
    case 'list_dir':
      return [{ path: stringArg(args, 'path') ?? '.', kind: 'read' }]
    case 'lsp': {
      const p = stringArg(args, 'path')
      return p ? [{ path: p, kind: args?.action === 'rename' ? 'write' : 'read' }] : []
    }
    case 'edit':
    case 'str_replace': {
      const p = stringArg(args, ...PATH_KEYS)
      return p ? [{ path: p, kind: 'write' }] : []
    }
    case 'edit_notebook': {
      const p = stringArg(args, 'target_notebook', ...PATH_KEYS)
      return p ? [{ path: p, kind: 'write' }] : []
    }
    case 'delete': {
      const p = stringArg(args, ...PATH_KEYS)
      return p ? [{ path: p, kind: 'delete' }] : []
    }
    case 'git_apply': {
      const patch = typeof args?.patch === 'string' ? args.patch : ''
      const check = args?.check === true
      return patchTouchedPaths(patch).map((t) => ({ path: t.path, kind: check ? 'read' : t.kind }))
    }
    default:
      return []
  }
}

/** The shell command a call runs, for command rules. */
function callCommand(name: string, args: Record<string, unknown> | undefined): string | null {
  if (name !== 'terminal' && name !== 'run_tests') return null
  return stringArg(args, 'command') ?? null
}

const TOKEN_SPLIT = /[\s'"`()<>|;&,=]+/
const UNRESOLVED_VAR = /\$[A-Za-z_{(]|%[A-Za-z_][A-Za-z0-9_]*%/
const CD_PROGRAMS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl'])

// ── The policy ──────────────────────────────────────────────────────────────

type CompiledRule = {
  rule: SourcedPermissionRule
  label: string
  tool?: RegExp
  command?: string[]
  path?: CompiledGlob
}

type Call = {
  name: string
  command: string | null
  facts: PathFact[]
}

const SOURCE_WORDS: Record<PermissionSource, string> = {
  settings: 'your settings',
  workspace: WORKSPACE_PERMISSIONS_FILE,
  'built-in': 'built in',
  skill: 'a skill’s allowed-tools'
}

/** `FOO=bar cmd`: what runs is decided by more than the words a skill named. */
const LEADING_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const NO_RETRY = 'This will not change on retry — do not repeat this call; ask the user or continue without it.'

function short(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function createPermissionPolicy(input: PermissionPolicyInput): PermissionPolicy {
  const platform = input.platform ?? process.platform
  const lib = platform === 'win32' ? path.win32 : path.posix
  const homeDir = input.homeDir ?? homedir()
  const syntax = input.syntax ?? (platform === 'win32' ? 'windows' : 'posix')
  const env = input.env ?? process.env
  const followLinks = input.resolveSymlinks ?? platform === process.platform
  const fold = (s: string): string => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s)

  const root = lib.resolve(input.workspaceRoot)
  const roots = followLinks ? unique([root, realpathIfExists(root)]) : [root]
  // Added folders: after the workspace, so a path in both reads as the workspace's.
  const extraRootForms = (input.extraRoots ?? []).flatMap((r) => {
    const resolved = lib.resolve(r)
    return followLinks ? [resolved, realpathIfExists(resolved)] : [resolved]
  })
  const userData = input.userDataDir ? lib.resolve(input.userDataDir) : null
  const userDataRoots = userData ? (followLinks ? unique([userData, realpathIfExists(userData)]) : [userData]) : []

  function unique(list: string[]): string[] {
    const seen = new Set<string>()
    return list.filter((p) => {
      const key = fold(p)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /** `child` is `parent` or inside it. */
  function within(parent: string, child: string): boolean {
    const rel = lib.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !lib.isAbsolute(rel))
  }
  function strictlyWithin(parent: string, child: string): boolean {
    return within(parent, child) && lib.relative(parent, child) !== ''
  }

  // The workspace may itself live in the data folder — the scratch home
  // workspace, a task's worktree — and its own files are the run's to touch.
  const workspaceInUserData = userDataRoots.some((u) => roots.some((r) => strictlyWithin(u, r)))
  /** Every root the run works in: the workspace's forms, then the added folders'. */
  const allRoots = unique([...roots, ...extraRootForms])
  // An added folder may be a task worktree in the data folder, like the workspace.
  const rootsInUserData = allRoots.filter((r) => userDataRoots.some((u) => strictlyWithin(u, r)))

  function inUserData(abs: string): boolean {
    if (!userDataRoots.some((u) => within(u, abs))) return false
    return !rootsInUserData.some((r) => within(r, abs))
  }

  /** A delete that takes the data folder with it. */
  function deletesUserData(abs: string): boolean {
    return userDataRoots.some((u) => within(abs, u))
  }

  const permissionsFiles = allRoots.map((r) => lib.join(r, ...WORKSPACE_PERMISSIONS_FILE.split('/')))

  const skillsDir =
    input.personalSkillsDir === null ? null : lib.resolve(input.personalSkillsDir ?? lib.join(homeDir, '.vyotiq', 'skills'))
  const skillsDirs = skillsDir ? (followLinks ? unique([skillsDir, realpathIfExists(skillsDir)]) : [skillsDir]) : []

  /** A change to a personal skill: inside the folder, or a delete that takes it. */
  function changesPersonalSkills(fact: PathFact): boolean {
    if (fact.kind === 'read') return false
    return skillsDirs.some((dir) => within(dir, fact.abs) || (fact.kind === 'delete' && within(fact.abs, dir)))
  }

  function factFor(abs: string, kind: PathKind, shown: string): PathFact[] {
    const forms = followLinks ? unique([abs, realpathIfExists(abs)]) : [abs]
    return forms.map((form) => {
      let rel: string | null = null
      // Relative to the workspace, or else to the added folder it is in.
      for (const r of allRoots) {
        if (within(r, form)) {
          rel = slashes(lib.relative(r, form))
          break
        }
      }
      return { abs: form, absKey: slashes(form), rel, kind, shown }
    })
  }

  function expandHome(token: string): string {
    let t = token
    if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = homeDir + t.slice(1)
    t = t.replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i, homeDir)
    if (env.APPDATA) t = t.replace(/^(?:\$env:APPDATA|%APPDATA%)(?=$|[\\/])/i, env.APPDATA)
    if (env.LOCALAPPDATA) t = t.replace(/^(?:\$env:LOCALAPPDATA|%LOCALAPPDATA%)(?=$|[\\/])/i, env.LOCALAPPDATA)
    if (env.XDG_CONFIG_HOME) t = t.replace(/^(?:\$XDG_CONFIG_HOME|\$\{XDG_CONFIG_HOME\})(?=$|[\\/])/, env.XDG_CONFIG_HOME)
    if (platform === 'win32') {
      // Git Bash spells C:\ as /c/.
      const msys = /^\/([A-Za-z])(?=\/|$)/.exec(t)
      if (msys) t = `${msys[1]}:\\${t.slice(3)}`
    }
    return t
  }

  /**
   * Every folder a word of this line may be read from: where it starts, and
   * wherever a `cd` in it goes. A static reading cannot tell which `cd` a word
   * follows, so each word is tried from all of them — it errs toward a match.
   */
  function commandBases(command: string, cwd: string): string[] {
    const bases = [cwd]
    for (const words of simpleCommands(command, syntax)) {
      if (!CD_PROGRAMS.has(commandProgramName(words[0]!))) continue
      const arg = words.slice(1).find((w) => !w.startsWith('-') && !/^\/d$/i.test(w))
      if (!arg) continue
      const target = expandHome(arg)
      if (UNRESOLVED_VAR.test(target)) continue
      for (const base of [...bases]) bases.push(lib.resolve(base, target))
      if (bases.length > 8) break
    }
    return unique(bases)
  }

  /** The words of a command line that read as paths, resolved from where it runs. */
  function commandFacts(command: string, cwd: string): PathFact[] {
    const out: PathFact[] = []
    const seen = new Set<string>()
    const bases = commandBases(command, cwd)
    for (const raw of command.split(TOKEN_SPLIT)) {
      if (!raw || raw.startsWith('-') || raw.includes('://') || raw.length > 1024) continue
      const token = expandHome(raw)
      if (UNRESOLVED_VAR.test(token)) continue
      for (const base of lib.isAbsolute(token) ? [cwd] : bases) {
        const abs = lib.resolve(base, token)
        const key = fold(abs)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(...factFor(abs, 'mention', raw))
      }
    }
    return out
  }

  /**
   * The data folder named anywhere in the text — inside a quoted script, after
   * an environment variable — past what splitting into words can see.
   */
  function textMentionsUserData(command: string): boolean {
    if (!userData) return false
    let text = command
      .replace(/(^|[\s'"=(])~(?=[\\/])/g, `$1${homeDir}`)
      .replace(/\$\{?HOME\}?|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%/gi, homeDir)
    if (env.APPDATA) text = text.replace(/\$env:APPDATA|%APPDATA%/gi, env.APPDATA)
    if (env.LOCALAPPDATA) text = text.replace(/\$env:LOCALAPPDATA|%LOCALAPPDATA%/gi, env.LOCALAPPDATA)
    if (env.XDG_CONFIG_HOME) text = text.replace(/\$\{?XDG_CONFIG_HOME\}?/g, env.XDG_CONFIG_HOME)
    text = slashes(text).replace(/\/{2,}/g, '/')
    if (platform === 'win32') text = text.replace(/(^|[\s'"=(])\/([A-Za-z])(?=\/)/g, '$1$2:')
    text = fold(text)
    const workspaceKeys = workspaceInUserData ? roots.map((r) => fold(trimSlash(slashes(r)))) : []
    const endsWord = (at: number): boolean => at >= text.length || !/[A-Za-z0-9._-]/.test(text[at]!)
    for (const u of userDataRoots) {
      const key = fold(trimSlash(slashes(u)))
      let at = text.indexOf(key)
      while (at >= 0) {
        if (endsWord(at + key.length)) {
          const inWorkspace = workspaceKeys.some((w) => text.startsWith(w, at) && endsWord(at + w.length))
          if (!inWorkspace) return true
        }
        at = text.indexOf(key, at + 1)
      }
    }
    return false
  }

  function buildCall(name: string, args: Record<string, unknown> | undefined): Call {
    const facts: PathFact[] = []
    for (const { path: p, kind } of toolPaths(name, args)) {
      facts.push(...factFor(lib.resolve(root, p), kind, p))
    }
    const command = callCommand(name, args)
    if (name === 'terminal' || name === 'run_tests') {
      const wd = name === 'terminal' ? stringArg(args, 'working_directory') : undefined
      const cwd = wd ? lib.resolve(root, wd) : root
      if (wd) facts.push(...factFor(cwd, 'read', wd))
      if (command) facts.push(...commandFacts(command, cwd))
    }
    return { name, command, facts }
  }

  // Configured rules, compiled once.
  const compiled: CompiledRule[] = input.rules.map((rule) => ({
    rule,
    label: permissionRuleLabel(rule),
    tool: rule.tool
      ? new RegExp(`^${rule.tool.split('*').map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*')}$`, 'i')
      : undefined,
    command: rule.command ? rule.command.trim().split(/\s+/) : undefined,
    path: rule.path ? compilePathGlob(rule.path, homeDir, platform) : undefined
  }))
  const defaultAsks = DEFAULT_ASK_PATHS.map((p) => ({ pattern: p, glob: compilePathGlob(p, homeDir, platform) }))
  const defaultExceptions = DEFAULT_ASK_PATH_EXCEPTIONS.map((p) => compilePathGlob(p, homeDir, platform))

  function subjectOf(glob: CompiledGlob, fact: PathFact): string | null {
    // A name at any depth (`**/.env`) is that name outside the workspace too.
    if (glob.anchor === 'rel') return fact.rel ?? (glob.anyDepth ? fact.absKey : null)
    if (glob.anchor === 'abs') return fact.absKey
    return fact.absKey.replace(/^[A-Za-z]:/, '')
  }

  function pathMatches(glob: CompiledGlob, fact: PathFact): boolean {
    const subject = subjectOf(glob, fact)
    return subject ? matchesSelfOrAncestor(glob.re, subject) : false
  }

  /** The built-in ask pattern this path falls under, skipping template env files. */
  function defaultAskFor(fact: PathFact): string | null {
    for (const { pattern, glob } of defaultAsks) {
      const subject = subjectOf(glob, fact)
      if (!subject) continue
      let s = subject
      for (;;) {
        const candidate = s
        if (glob.re.test(candidate) && !defaultExceptions.some((ex) => ex.anchor === glob.anchor && ex.re.test(candidate))) {
          return pattern
        }
        const cut = s.lastIndexOf('/')
        if (cut <= 0) break
        s = s.slice(0, cut)
      }
    }
    return null
  }

  function commandHasPrefix(command: string, words: string[]): boolean {
    const program = commandProgramName(words[0]!)
    return simpleCommands(command, syntax).some(
      (cmd) =>
        cmd.length >= words.length &&
        commandProgramName(cmd[0]!) === program &&
        words.every((w, i) => i === 0 || cmd[i] === w)
    )
  }

  function ruleMatches(cr: CompiledRule, call: Call): boolean {
    const { effect } = cr.rule
    if (cr.tool && !cr.tool.test(call.name)) return false
    if (cr.command) {
      if (!call.command) return false
      const ok =
        effect === 'allow'
          ? commandMatchesAllow(call.command, cr.rule.command!)
          : commandHasPrefix(call.command, cr.command)
      if (!ok) return false
    }
    if (cr.path) {
      // A path allow lifts the built-in secret asks; it never lets a shell
      // command through on the strength of the words it mentions.
      // An allow that also names a command was decided by the command.
      if (effect === 'allow' && call.command) return Boolean(cr.command)
      if (call.facts.length === 0) return false
      return effect === 'allow'
        ? call.facts.every((f) => pathMatches(cr.path!, f))
        : call.facts.some((f) => pathMatches(cr.path!, f))
    }
    return true
  }

  /** A path allow of the user's own that covers this file lifts the built-in ask. */
  function coveredByAllow(fact: PathFact, toolName: string): boolean {
    return compiled.some(
      (cr) =>
        cr.rule.effect === 'allow' &&
        cr.path !== undefined &&
        !cr.command &&
        (!cr.tool || cr.tool.test(toolName)) &&
        pathMatches(cr.path, fact)
    )
  }

  function what(call: Call, fact?: PathFact): string {
    if (fact) return fact.shown
    return call.command ? short(call.command, 80) : call.name
  }

  function matchedFact(cr: CompiledRule, call: Call): PathFact | undefined {
    return cr.path ? call.facts.find((f) => pathMatches(cr.path!, f)) : undefined
  }

  const skillGlobs = new Map<string, CompiledGlob>()
  function skillGlob(spec: NonNullable<SkillToolAllow['path']>): CompiledGlob {
    const key = `${spec.rootAnchored ? '/' : ''}${spec.pattern}`
    let glob = skillGlobs.get(key)
    if (!glob) {
      glob = compilePathGlob(spec.pattern, homeDir, platform, { rootAnchored: spec.rootAnchored })
      skillGlobs.set(key, glob)
    }
    return glob
  }

  /** One `allowed-tools` entry against this call — an allow rule's reading, a little narrower. */
  function skillAllowMatches(allow: SkillToolAllow, call: Call, args: Record<string, unknown> | undefined): boolean {
    const toolHit = allow.tools.some((t) =>
      t.endsWith('*') ? call.name.startsWith(t.slice(0, -1)) : t === call.name
    )
    if (!toolHit) return false
    if (allow.command) {
      const command = call.command?.trim()
      if (!command || LEADING_ENV_ASSIGNMENT.test(command)) return false
      if (!commandMatchesAllow(command, allow.command.words.join(' '))) return false
      if (allow.command.exact && command.split(/\s+/).length !== allow.command.words.length) return false
    }
    if (allow.path) {
      if (call.command || call.facts.length === 0) return false
      const glob = skillGlob(allow.path)
      if (!call.facts.every((f) => pathMatches(glob, f))) return false
    }
    if (allow.domain) {
      const url = stringArg(args, 'url')
      let host: string
      try {
        const parsed = new URL(url ?? '')
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
        host = parsed.hostname.toLowerCase()
      } catch {
        return false
      }
      if (host !== allow.domain && !host.endsWith(`.${allow.domain}`)) return false
    }
    return true
  }

  function evaluate(
    toolName: string,
    args: Record<string, unknown> | undefined,
    opts?: { skills?: readonly ActiveSkillAllows[] }
  ): PermissionVerdict | null {
    const call = buildCall(toolName, args)

    // 1. Protected paths.
    for (const fact of call.facts) {
      if (inUserData(fact.abs) || (fact.kind === 'delete' && deletesUserData(fact.abs))) {
        return {
          effect: 'deny',
          source: 'built-in',
          rule: 'protected: app data folder',
          reason: `Blocked: ${fact.shown} is in the app's data folder (keys, settings, browser cookies), which agent tools never touch. ${NO_RETRY}`
        }
      }
    }
    if (call.command && textMentionsUserData(call.command)) {
      return {
        effect: 'deny',
        source: 'built-in',
        rule: 'protected: app data folder',
        reason: `Blocked: this command names the app's data folder (keys, settings, browser cookies), which agent tools never touch. ${NO_RETRY}`
      }
    }
    let mentionsPermissionsFile: PathFact | undefined
    for (const fact of call.facts) {
      // Deleting a folder takes the file with it — when there is one to take.
      const hit = permissionsFiles.some((file) =>
        fold(fact.abs) === fold(file) || (fact.kind === 'delete' && within(fact.abs, file) && existsSync(file))
      )
      if (!hit) continue
      if (fact.kind === 'write' || fact.kind === 'delete') {
        return {
          effect: 'deny',
          source: 'built-in',
          rule: `protected: ${WORKSPACE_PERMISSIONS_FILE}`,
          reason: `Blocked: ${WORKSPACE_PERMISSIONS_FILE} holds this workspace's permission rules, which the agent cannot change. ${NO_RETRY}`
        }
      }
      if (fact.kind === 'mention') mentionsPermissionsFile ??= fact
    }

    // 2. Configured rules: deny, then ask, then allow.
    const matched = compiled.filter((cr) => ruleMatches(cr, call))
    const deny = matched.find((cr) => cr.rule.effect === 'deny')
    if (deny) {
      return {
        effect: 'deny',
        source: deny.rule.source,
        rule: deny.label,
        reason: `Blocked by permission rule "${deny.label}" (${SOURCE_WORDS[deny.rule.source]}): ${toolName} ${what(call, matchedFact(deny, call))}. ${NO_RETRY}`
      }
    }
    const ask = matched.find((cr) => cr.rule.effect === 'ask')
    if (ask) {
      return {
        effect: 'ask',
        source: ask.rule.source,
        rule: ask.label,
        reason: `${what(call, matchedFact(ask, call))} — permission rule "${ask.label}" (${SOURCE_WORDS[ask.rule.source]})`
      }
    }

    // 3. Built-in asks.
    if (mentionsPermissionsFile) {
      return {
        effect: 'ask',
        source: 'built-in',
        rule: `protected: ${WORKSPACE_PERMISSIONS_FILE}`,
        reason: `Names ${WORKSPACE_PERMISSIONS_FILE}, this workspace's permission rules`
      }
    }
    const skillChange = call.facts.find(changesPersonalSkills)
    if (skillChange) {
      return {
        effect: 'ask',
        source: 'built-in',
        rule: 'protected: personal skills',
        reason: `${skillChange.shown} — changes your personal skills, whose allowed-tools run without asking`
      }
    }
    for (const fact of call.facts) {
      const pattern = defaultAskFor(fact)
      if (pattern && !coveredByAllow(fact, toolName)) {
        return {
          effect: 'ask',
          source: 'built-in',
          rule: `ask path ${pattern}`,
          reason: `${fact.shown} may hold secrets — built-in rule "ask path ${pattern}"`
        }
      }
    }

    const allow = matched.find((cr) => cr.rule.effect === 'allow')
    if (allow) {
      return { effect: 'allow', source: allow.rule.source, rule: allow.label, reason: `Allowed by permission rule "${allow.label}"` }
    }
    // 4. An active skill's allowed-tools: an allow like your own, after it.
    for (const active of opts?.skills ?? []) {
      const hit = active.allows.find((a) => skillAllowMatches(a, call, args))
      if (hit) {
        return {
          effect: 'allow',
          source: 'skill',
          skill: active.skill,
          rule: `skill ${active.skill}: ${hit.entry}`,
          reason: `Allowed by skill "${active.skill}" (allowed-tools: ${hit.entry})`
        }
      }
    }
    return null
  }

  function hidesFromSearch(toolName: string, relPath: string): boolean {
    const abs = lib.resolve(root, relPath)
    // An absolute path is a hit in an added folder: matched as any call's path is.
    const facts: PathFact[] = lib.isAbsolute(relPath)
      ? factFor(abs, 'read', relPath)
      : [{ abs, absKey: slashes(abs), rel: slashes(relPath), kind: 'read', shown: relPath }]
    return facts.some((fact) => {
      if (inUserData(fact.abs)) return true
      const call: Call = { name: toolName, command: null, facts: [fact] }
      if (compiled.some((cr) => cr.rule.effect !== 'allow' && cr.path && !cr.command && ruleMatches(cr, call))) return true
      return defaultAskFor(fact) !== null && !coveredByAllow(fact, toolName)
    })
  }

  return { evaluate, hidesFromSearch }
}

// ── The workspace's own file ────────────────────────────────────────────────

export type WorkspacePermissions = {
  rules: SourcedPermissionRule[]
  /** Allow entries the file had: a folder cannot grant itself access. */
  ignoredAllow: number
  /** Entries that are not rules. */
  invalid: number
  /** Set when the file is there but unreadable as JSON. */
  error?: string
}

export function workspacePermissionsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ...WORKSPACE_PERMISSIONS_FILE.split('/'))
}

/**
 * `<workspace>/.vyotiq/permissions.json`: `{ "rules": [ … ] }`, same shape as
 * Settings. It came with the folder, so it can only add deny and ask rules —
 * its allow entries are ignored (and counted, for the log).
 */
export function readWorkspacePermissions(workspaceRoot: string): WorkspacePermissions {
  const file = workspacePermissionsPath(workspaceRoot)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { rules: [], ignoredAllow: 0, invalid: 0 }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { rules: [], ignoredAllow: 0, invalid: 0, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)
      ? (raw as { rules: unknown[] }).rules
      : []
  const out: WorkspacePermissions = { rules: [], ignoredAllow: 0, invalid: 0 }
  for (const entry of entries) {
    const parsed = PermissionRuleSchema.safeParse(entry)
    if (!parsed.success) {
      out.invalid++
      continue
    }
    if (parsed.data.effect === 'allow') {
      out.ignoredAllow++
      continue
    }
    out.rules.push({ ...parsed.data, source: 'workspace' })
  }
  return out
}

/** Electron's userData, or null outside the app (a unit test without a stub). */
export function appUserDataDir(): string | null {
  try {
    const dir = userDataRoot()
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    return null
  }
}

/**
 * The policy a run checks: Settings' rules plus the deny and ask rules in the
 * permissions file of the folder the user opened and, for a worktree, the
 * worktree's copy. Read once per invoke, like the rest of the settings.
 */
export function loadRunPermissionPolicy(input: {
  settingsRules: readonly PermissionRule[]
  /** The folder the task belongs to. */
  workspace: string
  /** Where its file tools run; differs for a worktree. */
  toolWorkspace: string
  /** The task's added folders: their permissions files add deny/ask rules too. */
  extraRoots?: readonly string[]
  userDataDir: string | null
  syntax?: 'posix' | 'windows'
  onFileProblem?: (problem: { path: string; ignoredAllow: number; invalid: number; error?: string }) => void
}): PermissionPolicy {
  const rules: SourcedPermissionRule[] = input.settingsRules.map((rule) => ({ ...rule, source: 'settings' }))
  const folders = [
    ...(input.toolWorkspace === input.workspace ? [input.workspace] : [input.workspace, input.toolWorkspace]),
    ...(input.extraRoots ?? [])
  ]
  for (const folder of folders) {
    const loaded = readWorkspacePermissions(folder)
    rules.push(...loaded.rules)
    if (loaded.ignoredAllow > 0 || loaded.invalid > 0 || loaded.error) {
      input.onFileProblem?.({
        path: workspacePermissionsPath(folder),
        ignoredAllow: loaded.ignoredAllow,
        invalid: loaded.invalid,
        ...(loaded.error ? { error: loaded.error } : {})
      })
    }
  }
  return createPermissionPolicy({
    rules,
    workspaceRoot: input.toolWorkspace,
    ...(input.extraRoots?.length ? { extraRoots: input.extraRoots } : {}),
    userDataDir: input.userDataDir,
    ...(input.syntax ? { syntax: input.syntax } : {})
  })
}
