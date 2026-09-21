import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { parseSkillFrontmatter } from './parse'
import { isSkillMdFilename, resolveSkillMdPath, SKILL_MD } from './paths'
import { serializeSkillMarkdown } from '../../../shared/utils/skillMarkdown'
import { normalizeTrigger } from '../../../shared/slashCommands'
import { realpathIfExists } from '../../workspace/safePath'
import { BUILTIN_COMMANDS } from '../slashCommands/builtins'

export type LocalSkillSource = 'project' | 'personal'
export type LocalSkillOrigin = 'vyotiq' | 'cursor'

export type LocalSkill = {
  id: string
  name: string
  description: string
  body: string
  root: string
  skillPath: string
  source: LocalSkillSource
  origin?: LocalSkillOrigin
  relativePath: string
  /** False when frontmatter sets `disable-model-invocation` — user-invoked only. */
  modelInvocable: boolean
}

export type LocalSkillListItem = {
  id: string
  name: string
  description: string
  source: LocalSkillSource
  origin?: LocalSkillOrigin
  skillPath: string
  relativePath: string
}

const CACHE_TTL_MS = 30_000
const MAX_LOCAL_SKILLS = 64

type CacheEntry = {
  fingerprint: string
  skills: LocalSkill[]
  builtAt: number
}

const cache = new Map<string, CacheEntry>()

let personalSkillsRootOverride: string | null = null

/** @internal test hook — do not use in production. */
export function setPersonalSkillsRootForTests(root: string | null): void {
  personalSkillsRootOverride = root
  cache.clear()
}

export function personalSkillsRoot(): string {
  return personalSkillsRootOverride ?? join(homedir(), '.vyotiq', 'skills')
}

export function localSkillId(source: LocalSkillSource, name: string): string {
  return `skill:local:${source}:${name}`
}

export function parseLocalSkillId(
  id: string
): { source: LocalSkillSource; name: string } | null {
  if (!id.startsWith('skill:local:')) return null
  const rest = id.slice('skill:local:'.length)
  const split = rest.indexOf(':')
  if (split <= 0) return null
  const source = rest.slice(0, split)
  const name = rest.slice(split + 1).trim()
  if ((source !== 'project' && source !== 'personal') || !name) return null
  return { source, name }
}

export function isSkillRelatedRelPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  if (n === 'skill.md' || n.endsWith('/skill.md')) return true
  return (
    n.startsWith('.vyotiq/skills/') ||
    n.startsWith('.cursor/skills/') ||
    n.includes('/.vyotiq/skills/') ||
    n.includes('/.cursor/skills/')
  )
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isInsideRoot(resolved: string, root: string): boolean {
  const rootKey = pathKey(root)
  const resolvedKey = pathKey(resolved)
  return resolvedKey === rootKey || resolvedKey.startsWith(rootKey + sep)
}

function dirMtime(path: string): string {
  try {
    return existsSync(path) ? String(statSync(path).mtimeMs) : '-'
  } catch {
    return '?'
  }
}

function fingerprintFor(workspacePath: string | null): string {
  const parts = [`personal:${dirMtime(personalSkillsRoot())}`]
  if (workspacePath) {
    parts.push(`vyotiq:${dirMtime(join(workspacePath, '.vyotiq', 'skills'))}`)
    parts.push(`cursor:${dirMtime(join(workspacePath, '.cursor', 'skills'))}`)
  }
  return parts.join('|')
}

function cacheKey(workspacePath: string | null): string {
  return workspacePath?.trim() ? workspacePath : ''
}

export function clearLocalSkillsCache(workspacePath?: string | null): void {
  if (workspacePath === undefined) {
    cache.clear()
    return
  }
  cache.delete(cacheKey(workspacePath))
  // Personal skills are shared across workspaces.
  if (workspacePath) cache.delete('')
}

function tryLoadSkillFromDir(skillDir: string): {
  name: string
  description: string
  body: string
  skillPath: string
  modelInvocable: boolean
} | null {
  const skillPath = resolveSkillMdPath(skillDir)
  if (!skillPath) return null
  try {
    const parsed = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
    return {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      skillPath,
      modelInvocable: parsed['disable-model-invocation'] !== true
    }
  } catch {
    return null
  }
}

function scanSkillRoot(
  root: string,
  source: LocalSkillSource,
  origin: LocalSkillOrigin | undefined,
  relativePrefix: string,
  out: LocalSkill[],
  seenNames: Set<string>
): void {
  if (out.length >= MAX_LOCAL_SKILLS) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  const sorted = [...entries].sort((a, b) => a.localeCompare(b))
  for (const name of sorted) {
    if (out.length >= MAX_LOCAL_SKILLS) return
    const abs = join(root, name)
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    const loaded = tryLoadSkillFromDir(abs)
    if (!loaded) continue
    const key = loaded.name.trim().toLowerCase()
    if (!key || seenNames.has(key)) continue
    seenNames.add(key)
    const fileName = basename(loaded.skillPath)
    out.push({
      id: localSkillId(source, loaded.name),
      name: loaded.name,
      description: loaded.description,
      body: loaded.body,
      root: abs,
      skillPath: loaded.skillPath,
      source,
      origin,
      relativePath: `${relativePrefix}/${name}/${fileName}`.replace(/\\/g, '/'),
      modelInvocable: loaded.modelInvocable
    })
  }
}

/** Load project + personal filesystem skills (most-specific first; first name wins). */
export function loadLocalSkills(workspacePath?: string | null): LocalSkill[] {
  const ws = workspacePath?.trim() || null
  const key = cacheKey(ws)
  const fingerprint = fingerprintFor(ws)
  const cached = cache.get(key)
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.skills
  }

  const skills: LocalSkill[] = []
  const seen = new Set<string>()
  if (ws) {
    scanSkillRoot(join(ws, '.vyotiq', 'skills'), 'project', 'vyotiq', '.vyotiq/skills', skills, seen)
    scanSkillRoot(join(ws, '.cursor', 'skills'), 'project', 'cursor', '.cursor/skills', skills, seen)
  }
  scanSkillRoot(personalSkillsRoot(), 'personal', undefined, '~/.vyotiq/skills', skills, seen)

  cache.set(key, { fingerprint, skills, builtAt: Date.now() })
  return skills
}

export function listLocalSkillItems(workspacePath?: string | null): LocalSkillListItem[] {
  return loadLocalSkills(workspacePath).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source,
    origin: s.origin,
    skillPath: s.skillPath,
    relativePath: s.relativePath
  }))
}

export function findLocalSkillById(
  id: string,
  workspacePath?: string | null
): LocalSkill | undefined {
  return loadLocalSkills(workspacePath).find((s) => s.id === id)
}

export function isAllowedLocalSkillPath(
  absPath: string,
  workspacePath?: string | null
): boolean {
  let real: string
  try {
    real = resolve(absPath)
    if (existsSync(real)) real = realpathSync(real)
  } catch {
    return false
  }
  if (!isSkillMdFilename(real)) return false

  const personal = realpathIfExists(personalSkillsRoot())
  if (isInsideRoot(real, personal)) return true

  const ws = workspacePath?.trim()
  if (!ws) return false
  const projectRoots = [
    join(ws, '.vyotiq', 'skills'),
    join(ws, '.cursor', 'skills')
  ]
  return projectRoots.some((root) => isInsideRoot(real, realpathIfExists(root)))
}

/** Mirrors `SkillNameSchema.max(64)` — a longer `name:` fails frontmatter parsing. */
const MAX_SKILL_NAME_LEN = 64
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_SKILL_WORD_RE = /(?:^|-)(?:anthropic|claude)(?:-|$)/i

function trimSlugEdges(value: string): string {
  return value.replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function isValidSkillName(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= MAX_SKILL_NAME_LEN &&
    SKILL_NAME_RE.test(slug) &&
    !RESERVED_SKILL_WORD_RE.test(slug)
  )
}

/**
 * True when `absPath` lives under the shared personal skills root. Edits there
 * are visible from every workspace, so they must invalidate every cache key —
 * `fingerprintFor` only samples the root's own mtime, which rewriting a nested
 * SKILL.md does not change.
 */
function isPersonalSkillPath(absPath: string): boolean {
  return isInsideRoot(resolve(absPath), realpathIfExists(personalSkillsRoot()))
}

function skillSlug(title?: string): string {
  // Trim the edges again after the length cap: slicing mid-word can leave a
  // trailing '-', which fails SKILL_NAME_RE and would discard the whole title.
  const n = trimSlugEdges(
    trimSlugEdges(normalizeTrigger(title || '').replace(/[^a-z0-9-]/g, '-')).slice(
      0,
      MAX_SKILL_NAME_LEN
    )
  )
  if (isValidSkillName(n)) return n
  return `skill-${new Date().toISOString().slice(0, 10)}`
}

/** `base` with an `-N` disambiguator, kept within the 64-char name limit. */
function slugWithSuffix(base: string, n: number): string {
  if (n <= 1) return base
  const suffix = `-${n}`
  const head = trimSlugEdges(base.slice(0, MAX_SKILL_NAME_LEN - suffix.length))
  return `${head}${suffix}`
}

/**
 * Pick a folder slug that is free on disk, does not collide with an existing
 * local skill `name:` (any root — `scanSkillRoot` drops later duplicates, so a
 * colliding stub would be written but never listed), does not shadow a builtin
 * slash trigger, and stays a valid skill name.
 */
function uniqueSkillDir(
  parent: string,
  base: string,
  taken: ReadonlySet<string>
): { dir: string; slug: string } {
  for (let n = 1; n <= 1000; n += 1) {
    const slug = slugWithSuffix(base, n)
    if (!isValidSkillName(slug)) continue
    if (taken.has(slug)) continue
    const dir = join(parent, slug)
    if (existsSync(dir)) continue
    return { dir, slug }
  }
  throw new Error(`Could not find a free skill name for "${base}"`)
}

/**
 * Slugs a new skill must avoid: every local skill `name:` already visible from
 * this workspace, plus builtin slash triggers (`mergeByTrigger` gives builtins
 * priority, so a skill named `help` would never be reachable as `/help`).
 */
function takenSkillNames(workspacePath: string | null): Set<string> {
  const taken = new Set<string>()
  for (const skill of loadLocalSkills(workspacePath)) {
    const key = skill.name.trim().toLowerCase()
    if (key) taken.add(key)
  }
  for (const command of BUILTIN_COMMANDS) {
    const key = normalizeTrigger(command.trigger)
    if (key) taken.add(key)
  }
  return taken
}

export type CreateLocalSkillResult = {
  path: string
  relativePath: string
  name: string
  source: LocalSkillSource
}

/** Write a SKILL.md stub under project or personal skills. */
export function createLocalSkill(args: {
  workspacePath?: string | null
  title?: string
  scope?: LocalSkillSource
}): CreateLocalSkillResult {
  const scope: LocalSkillSource = args.scope === 'personal' ? 'personal' : 'project'
  const base = skillSlug(args.title)

  let parent: string
  let relativePrefix: string
  if (scope === 'personal') {
    parent = personalSkillsRoot()
    relativePrefix = '~/.vyotiq/skills'
  } else {
    const ws = args.workspacePath?.trim()
    if (!ws) {
      throw new Error('Open a workspace to create a project skill')
    }
    parent = join(ws, '.vyotiq', 'skills')
    relativePrefix = '.vyotiq/skills'
  }

  mkdirSync(parent, { recursive: true })
  const parentResolved = resolve(parent)
  const { dir, slug } = uniqueSkillDir(parent, base, takenSkillNames(args.workspacePath ?? null))
  if (!isInsideRoot(resolve(dir), parentResolved)) {
    throw new Error('Skill path escapes skills root')
  }
  // No title given: title the stub after the slug that was actually taken.
  const displayTitle = (args.title ?? '').trim() || slug
  const absolute = join(dir, SKILL_MD)
  const body = [
    '---',
    `name: ${slug}`,
    'description: Describe this skill and when to use it.',
    'metadata:',
    '  version: "1.0.0"',
    '---',
    '',
    `# ${displayTitle}`,
    '',
    '## Instructions',
    '',
    'Describe the workflow the agent should follow.',
    ''
  ].join('\n')
  // Fail loudly instead of writing a stub that every reader silently drops.
  parseSkillFrontmatter(body)
  mkdirSync(dir, { recursive: true })
  writeFileSync(absolute, body, 'utf8')
  clearLocalSkillsCache(args.workspacePath ?? null)
  // Personal skills are shared by every workspace key, not just this one.
  if (scope === 'personal') clearLocalSkillsCache()

  return {
    path: absolute,
    relativePath: `${relativePrefix}/${slug}/${SKILL_MD}`,
    name: slug,
    source: scope
  }
}

function assertSkillFileNotAtRoot(skillDir: string, workspacePath?: string | null): void {
  const personal = resolve(personalSkillsRoot())
  if (pathKey(skillDir) === pathKey(personal)) {
    throw new Error('Skill file must live in a named skill folder')
  }
  const ws = workspacePath?.trim()
  if (!ws) return
  const projectRoots = [
    resolve(join(ws, '.vyotiq', 'skills')),
    resolve(join(ws, '.cursor', 'skills'))
  ]
  if (projectRoots.some((root) => pathKey(skillDir) === pathKey(root))) {
    throw new Error('Skill file must live in a named skill folder')
  }
}

function relativeFromSkillPath(absPath: string, workspacePath?: string | null): string {
  // Bases must be real paths: `absPath` is realpath-resolved by the write
  // path, and on macOS tmpdir sits under the /var → /private/var symlink, so
  // a raw base made isInsideRoot miss and relative() emit an absolute path.
  const personal = realpathIfExists(personalSkillsRoot())
  if (isInsideRoot(absPath, personal)) {
    const rel = relative(personal, absPath).split(sep).join('/')
    return `~/.vyotiq/skills/${rel}`
  }
  const ws = workspacePath?.trim()
  if (ws) {
    const wsRoot = realpathIfExists(resolve(ws))
    if (isInsideRoot(absPath, wsRoot)) {
      return relative(wsRoot, absPath).split(sep).join('/')
    }
  }
  return absPath.split(sep).join('/')
}

export type LocalSkillFile = {
  skillPath: string
  content: string
  name: string
  description: string
  license?: string
  compatibility?: string
  allowedTools?: string
  metadata?: Record<string, string>
  body: string
}

/** Read a path-gated local SKILL.md. */
export function readLocalSkillFile(
  skillPath: string,
  workspacePath?: string | null
): LocalSkillFile {
  if (!isAllowedLocalSkillPath(skillPath, workspacePath)) {
    throw new Error('Path is not a local skill file')
  }
  let real = resolve(skillPath)
  if (existsSync(real)) real = realpathSync(real)
  const content = readFileSync(real, 'utf8')
  const parsed = parseSkillFrontmatter(content)
  return {
    skillPath: real,
    content,
    name: parsed.name,
    description: parsed.description,
    license: parsed.license,
    compatibility: parsed.compatibility,
    allowedTools: parsed['allowed-tools'],
    metadata: parsed.metadata,
    body: parsed.body
  }
}

export type WriteLocalSkillResult = {
  skillPath: string
  relativePath: string
  name: string
}

/** Validate, write, and rename the skill folder when `name` changes. */
export function writeLocalSkillFile(args: {
  skillPath: string
  content: string
  workspacePath?: string | null
}): WriteLocalSkillResult {
  if (!isAllowedLocalSkillPath(args.skillPath, args.workspacePath)) {
    throw new Error('Path is not a local skill file')
  }
  const parsed = parseSkillFrontmatter(args.content)
  let currentPath = resolve(args.skillPath)
  if (existsSync(currentPath)) currentPath = realpathSync(currentPath)
  const skillDir = dirname(currentPath)
  assertSkillFileNotAtRoot(skillDir, args.workspacePath)

  let destDir: string | null = null
  const currentFolder = basename(skillDir)
  if (parsed.name !== currentFolder) {
    destDir = join(dirname(skillDir), parsed.name)
    if (!isInsideRoot(resolve(destDir), resolve(dirname(skillDir)))) {
      throw new Error('Skill path escapes skills root')
    }
    if (existsSync(destDir) && pathKey(destDir) !== pathKey(skillDir)) {
      throw new Error(`A skill folder named "${parsed.name}" already exists`)
    }
  }

  const normalized = serializeSkillMarkdown(parsed, parsed.body)
  writeFileSync(currentPath, normalized, 'utf8')

  let nextPath = currentPath
  if (destDir && pathKey(destDir) !== pathKey(skillDir)) {
    renameSync(skillDir, destDir)
    nextPath = join(destDir, basename(currentPath))
  }
  if (!isAllowedLocalSkillPath(nextPath, args.workspacePath)) {
    throw new Error('Renamed skill path escapes skills root')
  }
  clearLocalSkillsCache(args.workspacePath ?? null)
  if (isPersonalSkillPath(nextPath)) clearLocalSkillsCache()
  return {
    skillPath: nextPath,
    relativePath: relativeFromSkillPath(nextPath, args.workspacePath),
    name: parsed.name
  }
}

/** Delete the skill folder that contains the gated SKILL.md. */
export function deleteLocalSkillFile(
  skillPath: string,
  workspacePath?: string | null
): void {
  if (!isAllowedLocalSkillPath(skillPath, workspacePath)) {
    throw new Error('Path is not a local skill file')
  }
  let real = resolve(skillPath)
  if (existsSync(real)) real = realpathSync(real)
  const skillDir = dirname(real)
  assertSkillFileNotAtRoot(skillDir, workspacePath)
  const personal = isPersonalSkillPath(real)
  rmSync(skillDir, { recursive: true, force: true })
  clearLocalSkillsCache(workspacePath ?? null)
  if (personal) clearLocalSkillsCache()
}
